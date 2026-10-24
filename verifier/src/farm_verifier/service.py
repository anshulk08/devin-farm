"""C5 verifier HTTP service on 127.0.0.1:8090 (rigd is the only client).

One camera-owner thread (`FrameHub`) feeds /snapshot, /stream, /observe, /confirm_idle and /calibrate.
Every failure (camera missing, stale frames, uncalibrated, unimplemented assertion) is a `passed: false`
result with the reason, never a pass.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from fastapi import FastAPI, Query, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, evidence, grid, unoq
from .assertions import evaluate
from .capture import DEFAULT_EXPOSURE, Camera, find_camera
from .clip import write_clip_files
from .hub import FrameHub, Source
from .leds import LED_ASSERTIONS, LedPoints
from .matrix import Calibration, calibrate, classify, sample_cells

ROOT = Path(__file__).resolve().parents[2]
CALIBRATION_IMAGE = ROOT / "images" / "calibrate.txt"
DEFAULT_DEVICES = ("unoq-1", "pico-1")
STALE_S = 2.0
MAX_DURATION_S = 30.0
IDLE_WINDOW_S = 4.5
CENTRE = (3, 6)  # C8 idle heartbeat cell (row, col)
CORNERS = ((0, 0), (0, 12), (7, 0), (7, 12))


def plain(o: Any) -> Any:
    """JSON-safe copy (numpy scalars/arrays -> Python)."""
    if isinstance(o, dict):
        return {str(k): plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [plain(v) for v in o]
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return o


class ObserveReq(BaseModel):
    device: str
    assertions: list[dict] = Field(default_factory=list)
    duration_s: float = 5.0
    run_id: str = ""


class DeviceReq(BaseModel):
    device: str
    show: bool = False  # push the calibration image to the Uno Q first (only when rigd is not using the board)


def device_type(device: str) -> str:
    return device.split("-")[0]


def unavailable(a: dict, why: str) -> dict:
    return {"type": a.get("type", ""), "target": a.get("target"), "passed": False, "measured": None,
            "expected": {k: v for k, v in a.items() if k not in ("type", "target")}, "uncertainty": None,
            "detail": f"cannot verify: {why}", "self_reported": False}


class Verifier:
    def __init__(self, hub: FrameHub, state_dir: Path, evidence_root: Path, devices: tuple[str, ...] = DEFAULT_DEVICES,
                 serial: str | None = None):
        self.hub, self.state, self.evidence_root = hub, Path(state_dir), Path(evidence_root)
        self.devices, self.serial = devices, serial
        self.lock = threading.Lock()  # one observation/calibration at a time
        self.state.mkdir(parents=True, exist_ok=True)
        self.evidence_root.mkdir(parents=True, exist_ok=True)

    # ---- calibration state ---------------------------------------------------------------
    def cal_path(self, device: str) -> Path:
        return self.state / f"{device}.calibration.json"

    def leds_path(self, device: str) -> Path:
        return self.state / f"{device}.leds.json"

    def cal(self, device: str) -> Calibration | None:
        p = self.cal_path(device)
        return Calibration.load(p) if p.exists() else None

    def points(self, device: str) -> LedPoints | None:
        p = self.leds_path(device)
        return LedPoints.load(p) if p.exists() else None

    def calibrated(self, device: str) -> bool:
        return self.cal_path(device).exists() if device_type(device) == "unoq" else self.leds_path(device).exists()

    # ---- C5 ------------------------------------------------------------------------------
    def health(self) -> dict:
        age = self.hub.age_s()
        ok = age is not None and age <= STALE_S
        out = {"ok": ok, "fps": self.hub.fps(), "last_frame_age_s": None if age is None else round(age, 3),
               "calibrated": {d: self.calibrated(d) for d in self.devices}, "version": __version__}
        if not ok:
            out["error"] = self.hub.error or "no fresh camera frame"
        return out

    def snapshot(self, device: str) -> bytes | None:
        f = self.hub.fresh(STALE_S)
        if f is None:
            return None
        img = f[1]
        cal = self.cal(device) if device_type(device) == "unoq" else None
        if cal is not None and tuple(cal.image_size) == img.shape[1::-1]:
            x0, y0, x1, y1 = cal.roi(1.5)
            img = img[y0:y1, x0:x1]
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
        return buf.tobytes() if ok else None

    def stream(self, device: str, fps: float = 10.0):
        last, gap = 0.0, 1.0 / fps
        while True:
            f = self.hub.wait_next(last, 3.0)
            if f is None:
                return  # camera stalled: end the stream rather than repeat an old frame
            last = f[0]
            jpg = self.snapshot(device)
            if jpg:
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n"
            time.sleep(gap)

    def calibrate(self, device: str, show: bool = False) -> dict:
        if device_type(device) != "unoq":
            return {"ok": False, "detail": f"calibration for {device!r} is not implemented (only the Uno Q matrix)"}
        if self.hub.fresh(STALE_S) is None:
            return {"ok": False, "detail": f"camera unavailable: {self.hub.error or 'no fresh frame'}"}
        with self.lock:
            try:
                if show:
                    unoq.show(grid.load(CALIBRATION_IMAGE), serial=self.serial, make_default=False)
                    time.sleep(1.5)
                rec = self.hub.record(2.0)
                if rec.error:
                    return {"ok": False, "detail": rec.error}
                cal = calibrate([g for _, g in rec.gray], exposure=getattr(self.hub, "exposure", None))
            except RuntimeError as e:
                return {"ok": False, "detail": str(e)}
            cal.save(self.cal_path(device))
        return {"ok": True, "detail": f"calibrated {device}: pitch {cal.pitch_px:.1f} px, reprojection {cal.reproj_px:.2f} px",
                "roi": list(cal.roi()), "pitch_px": round(cal.pitch_px, 2)}

    def confirm_idle(self, device: str) -> dict:
        """C8 `unoq-1`: four corner pixels steady, centre pixel heartbeat at 0.5 Hz, everything else dark."""
        if device_type(device) != "unoq":
            return {"ok": False, "detail": f"idle check for {device!r} is not implemented", "measured": {}}
        cal = self.cal(device)
        if cal is None:
            return {"ok": False, "detail": "cannot confirm idle: matrix not calibrated", "measured": {}}
        if self.hub.fresh(STALE_S) is None:
            return {"ok": False, "detail": f"cannot confirm idle: camera unavailable ({self.hub.error or 'stale frames'})", "measured": {}}
        with self.lock:
            rec = self.hub.record(IDLE_WINDOW_S)
        if rec.error:
            return {"ok": False, "detail": f"cannot confirm idle: {rec.error}", "measured": {}}
        if rec.gray[0][1].shape[::-1] != tuple(cal.image_size):
            return {"ok": False, "detail": "cannot confirm idle: frame size differs from calibration", "measured": {}}
        ts = np.array([t for t, _ in rec.gray])
        raw = np.stack([sample_cells(g, cal) for _, g in rec.gray])
        w = min(3, len(raw))
        vals = np.stack([raw[max(0, i - w + 1):i + 1].max(axis=0) for i in range(len(raw))])
        lit = np.stack([classify(v, cal)[0] for v in vals])  # (N, 8, 13)
        frac = lit.mean(axis=0)
        corners = [float(frac[r, c]) for r, c in CORNERS]
        mask = np.ones((8, 13), bool)
        mask[tuple(zip(*CORNERS))] = False
        mask[CENTRE] = False
        stray = frac * mask
        centre = lit[:, CENTRE[0], CENTRE[1]]
        trans = int((centre[1:] != centre[:-1]).sum())
        span = float(ts[-1] - ts[0])
        measured = {"corner_lit_fraction": [round(c, 2) for c in corners], "centre_lit_fraction": round(float(centre.mean()), 2),
                    "centre_transitions": trans, "stray_cells": int((stray > 0.2).sum()), "frames": len(lit), "duration_s": round(span, 2)}
        if span < 3.0 or len(lit) < 10:
            return {"ok": False, "detail": f"cannot confirm idle: only {len(lit)} frames over {span:.1f}s", "measured": measured}
        problems = []
        if min(corners) < 0.9:
            problems.append("corner pixels are not steadily lit")
        if (stray > 0.2).any():
            cells = ", ".join(f"r{r}c{c}" for r, c in zip(*np.nonzero(stray > 0.2)))
            problems.append(f"unexpected lit cells: {cells}")
        if not (0.2 <= centre.mean() <= 0.8) or trans < 1:
            problems.append(f"centre pixel is not blinking (lit {centre.mean():.0%} of frames, {trans} transitions)")
        elif trans >= 3 and span / (trans / 2) > 0:
            hz = (trans / 2) / span
            measured["centre_hz"] = round(hz, 2)
            if not 0.25 <= hz <= 1.0:
                problems.append(f"centre pixel blinks at {hz:.2f} Hz, expected 0.5 Hz")
        if problems:
            return {"ok": False, "detail": "not the idle pattern: " + "; ".join(problems), "measured": measured}
        return {"ok": True, "detail": "idle pattern confirmed: corners steady, centre heartbeat", "measured": measured}

    # ---- observe -------------------------------------------------------------------------
    def observe(self, req: ObserveReq) -> dict:
        dev, dtype = req.device, device_type(req.device)
        duration = min(max(float(req.duration_s), 1.0), MAX_DURATION_S)
        holds = [float(a.get("hold_s", 2.0)) + 1.0 for a in req.assertions if a.get("type") == "matrix_frame"]
        duration = min(max([duration] + holds), MAX_DURATION_S)
        cal = self.cal(dev) if dtype == "unoq" else None
        pts = self.points(dev)
        if self.hub.fresh(STALE_S) is None:
            why = f"camera unavailable: {self.hub.error or 'no fresh frame'}"
            return {"results": [unavailable(a, why) for a in req.assertions], "evidence_dir": None}
        roi = cal.roi(1.5) if cal is not None else None
        sampler = pts.sample if pts is not None else None
        with self.lock:
            rec = self.hub.record(duration, roi=roi, sampler=sampler)
        if rec.error:
            return {"results": [unavailable(a, rec.error) for a in req.assertions], "evidence_dir": None}
        results = [plain(self._evaluate(a, dev, dtype, rec, cal, pts)) for a in req.assertions]
        ev = self._write_evidence(req, results, rec, cal)
        return {"results": results, "evidence_dir": ev}

    def _evaluate(self, a: dict, dev: str, dtype: str, rec, cal, pts) -> dict:
        kind, target = a.get("type"), str(a.get("target") or "")
        if target and not target.startswith(dtype + "."):
            return unavailable(a, f"target {target!r} is not on device {dev!r}")
        if kind in LED_ASSERTIONS:
            return LED_ASSERTIONS[kind](a, rec.samples, pts)
        try:
            return evaluate(a, rec.gray, cal)
        except (KeyError, ValueError, TypeError) as e:
            return unavailable(a, f"malformed assertion: {e}")

    def _write_evidence(self, req: ObserveReq, results: list[dict], rec, cal) -> str | None:
        name = f"{int(time.time())}-{(req.run_id or 'run')[:24]}-{uuid.uuid4().hex[:6]}"
        out = self.evidence_root / name
        try:
            out.mkdir(parents=True, exist_ok=True)
            n = 0
            full = rec.last_full
            if full is not None and cal is not None:
                for r in results:
                    if r["type"] == "matrix_frame" and r.get("measured") and r.get("expected", {}).get("ascii"):
                        r["evidence_frame"] = evidence.write(out, full, cal, r, name=f"frame-{n}.jpg").name
                        n += 1
            if full is not None and n == 0:
                x0, y0, x1, y1 = cal.roi(1.5) if cal is not None else (0, 0, full.shape[1], full.shape[0])
                cv2.imwrite(str(out / f"frame-{n}.jpg"), full[y0:y1, x0:x1])
            files = write_clip_files(out, rec.bgr, results)
            (out / "results.json").write_text(json.dumps({"results": results, "run_id": req.run_id, "device": req.device,
                                                          "verifier_version": __version__}, indent=1))
            del files
            return str(out)
        except Exception:  # noqa: BLE001 - evidence is best effort; the verdict stands without it
            return str(out) if out.exists() else None


def build_app(verifier: Verifier) -> FastAPI:
    app = FastAPI(title="farm-verifier", version=__version__)

    @app.get("/health")
    def health() -> dict:
        return verifier.health()

    @app.post("/observe")
    def observe(req: ObserveReq) -> dict:
        return verifier.observe(req)

    @app.post("/confirm_idle")
    def confirm_idle(req: DeviceReq) -> dict:
        return plain(verifier.confirm_idle(req.device))

    @app.post("/calibrate")
    def calibrate_(req: DeviceReq) -> dict:
        return plain(verifier.calibrate(req.device, req.show))

    @app.get("/snapshot")
    def snapshot(device: str = Query("unoq-1")):
        jpg = verifier.snapshot(device)
        if jpg is None:
            return JSONResponse({"ok": False, "detail": f"camera unavailable: {verifier.hub.error or 'no fresh frame'}"}, status_code=503)
        return Response(jpg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/stream")
    def stream(device: str = Query("unoq-1")):
        if verifier.hub.fresh(STALE_S) is None:
            return JSONResponse({"ok": False, "detail": f"camera unavailable: {verifier.hub.error or 'no fresh frame'}"}, status_code=503)
        return StreamingResponse(verifier.stream(device), media_type="multipart/x-mixed-replace; boundary=frame")

    return app


def make_app(camera: str | None = None, exposure: int = DEFAULT_EXPOSURE, serial: str | None = None,
             opener: Callable[[], Source] | None = None) -> FastAPI:
    state = Path(os.environ.get("FARM_VERIFIER_STATE", ROOT / "state"))
    ev = Path(os.environ.get("FARM_VERIFIER_EVIDENCE", state / "evidence"))

    def default_open() -> Source:
        cam = Camera(camera or os.environ.get("FARM_VERIFIER_CAMERA") or find_camera(), exposure=exposure)
        hub.exposure = exposure  # type: ignore[attr-defined]
        return cam

    hub = FrameHub(opener or default_open)
    hub.exposure = exposure  # type: ignore[attr-defined]
    hub.start()
    return build_app(Verifier(hub, state, ev, serial=serial))


def serve(host: str, port: int, camera: str | None, exposure: int, serial: str | None) -> None:
    import uvicorn

    uvicorn.run(make_app(camera, exposure, serial), host=host, port=port, log_level="info")
