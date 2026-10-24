"""In-process mock rig: the C1 session API and C3 control API of a rigd with mock drivers and a
mock verifier, on one port. Control's neighbour for mock mode and tests (team rule 2).
Identity comes from `X-Mock-Node` (the same convention as `rigd --mock-identity`).

Mock verifier rule (deterministic, so demos tell the ✗ → fix → ✓ story): a run whose SHA starts
with "bad" behaves wrong physically while its logs still say READY; any other SHA passes."""
from __future__ import annotations

import asyncio
import json
import random
import secrets
import os
import time

import httpx
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse

from ..events import encode_sse
from .assets import CLIP_GIF, FRAME_JPEG

MAX_ACTIVE_PER_NODE = 2
HARD_CAP_S = 1800.0
# Demo recording only: drop the "mock" labels from rig/evidence payloads (the UI's honesty badges).
UNLABELLED = os.environ.get("FARM_MOCK_UNLABELLED") == "1"


class RigAPIError(Exception):
    def __init__(self, status: int, code: str, message: str, next_call: str = ""):
        super().__init__(message)
        self.status, self.code, self.message, self.next_call = status, code, message, next_call


@dataclass
class MLease:
    lease_id: str
    device: str
    holder: str
    ttl_s: float
    state: str = "queued"
    token: int | None = None
    granted_at: float | None = None
    expires_at: float | None = None
    max_hold_until: float | None = None
    since: float = field(default_factory=time.time)
    granted: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class MDevice:
    id: str
    type: str
    outputs: list[str]
    status: str = "free"
    token: int = 0
    lease: MLease | None = None
    queue: list[MLease] = field(default_factory=list)
    last_verdict: dict[str, Any] | None = None


@dataclass
class MRun:
    run_id: str
    device: str
    lease_id: str
    sha: str
    path: str
    state: str = "queued"
    build_time_s: float | None = None
    logs: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class MVerify:
    verify_id: str
    device: str
    lease_id: str
    state: str = "pending"
    results: list[dict[str, Any]] | None = None
    evidence_id: str | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


DEFAULT_OUTPUTS = {"pico": ["pico.led", "pico.leds"], "unoq": ["unoq.matrix", "unoq.rgb1"]}


class MockRig:
    def __init__(self, rig_id: str, devices: list[tuple[str, str]], speed: float = 1.0,
                 health_interval_s: float = 5.0):
        self.rig_id = rig_id
        self.devices = {d: MDevice(d, t, list(DEFAULT_OUTPUTS.get(t, []))) for d, t in devices}
        self.leases: dict[str, MLease] = {}
        self.runs: dict[str, MRun] = {}
        self.verifies: dict[str, MVerify] = {}
        self.evidence: dict[str, dict[str, bytes]] = {}
        self.maintenance = False
        self.speed = speed
        self.health_interval_s = health_interval_s
        self._subs: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()
        self._tasks: set[asyncio.Task[Any]] = set()

    # ---- infrastructure -------------------------------------------------------------------
    def emit(self, name: str, **data: Any) -> None:
        data.update(rig_id=self.rig_id, ts=time.time())
        for q in list(self._subs):
            q.put_nowait((name, data))

    def spawn(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds * self.speed)

    def start(self) -> None:
        self.spawn(self._health_loop())
        self.spawn(self._expiry_loop())

    async def stop(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def health(self) -> dict[str, Any]:
        return {"temp_c": round(48 + random.random() * 4, 1), "load1": round(0.4 + random.random() * 0.3, 2),
                "mem_free_mb": 2400, "throttled": False, "camera_ok": True, "verifier_online": True}

    async def _health_loop(self) -> None:
        while True:
            self.emit("rig_health", **self.health())
            await asyncio.sleep(self.health_interval_s)

    async def _expiry_loop(self) -> None:
        while True:
            now = time.time()
            for lease in list(self.leases.values()):
                if lease.state == "active" and (now > (lease.expires_at or 0) or now > (lease.max_hold_until or 0)):
                    self._end(lease, "expired")
            await asyncio.sleep(0.25)

    # ---- views ----------------------------------------------------------------------------
    def device_json(self, dev: MDevice) -> dict[str, Any]:
        d: dict[str, Any] = {"id": dev.id, "type": dev.type, "status": dev.status, "queue_depth": len(dev.queue),
                             "outputs": dev.outputs, "describe_url": f"/v1/devices/{dev.id}/describe"}
        if dev.lease:
            d["holder"] = dev.lease.holder
        return d

    def rig_json(self) -> dict[str, Any]:
        return {"rig_id": self.rig_id, "online": True, "model": "Jetson Orin Nano" if UNLABELLED else "mock Jetson",
                "mock": not UNLABELLED, **self.health(),
                "maintenance": self.maintenance, "devices": [self.device_json(d) for d in self.devices.values()]}

    def state_json(self) -> dict[str, Any]:
        devices = []
        for dev in self.devices.values():
            d = self.device_json(dev)
            if dev.lease:
                d["lease"] = {"lease_id": dev.lease.lease_id, "holder": dev.lease.holder, "token": dev.lease.token,
                              "granted_at": dev.lease.granted_at, "expires_at": dev.lease.expires_at}
            d["queue"] = [{"lease_id": q.lease_id, "holder": q.holder, "position": i + 1, "since": q.since}
                          for i, q in enumerate(dev.queue)]
            if dev.last_verdict:
                d["last_verdict"] = dev.last_verdict
            devices.append(d)
        return {"rig": self.rig_json(), "devices": devices, "camera": {"ok": True, "fps": 30.0, "last_frame_age_s": 0.03}}

    def lease_json(self, lease: MLease) -> dict[str, Any]:
        d: dict[str, Any] = {"lease_id": lease.lease_id, "device": lease.device, "state": lease.state}
        if lease.state == "queued":
            d["position"] = self.devices[lease.device].queue.index(lease) + 1
        if lease.state == "active":
            d.update(token=lease.token, expires_at=lease.expires_at, max_hold_until=lease.max_hold_until)
        return d

    # ---- lease engine (C2) ----------------------------------------------------------------
    def _emit_device(self, dev: MDevice, **extra: Any) -> None:
        self.emit("device", device=dev.id, status=dev.status, holder=dev.lease.holder if dev.lease else None,
                  queue_depth=len(dev.queue), **extra)

    def _grant(self, dev: MDevice, lease: MLease) -> None:
        now = time.time()
        dev.token += 1
        lease.state, lease.token, lease.granted_at = "active", dev.token, now
        lease.expires_at, lease.max_hold_until = now + lease.ttl_s, now + HARD_CAP_S
        dev.lease, dev.status = lease, "leased"
        self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event="granted",
                  token=lease.token, expires_at=lease.expires_at)
        self._emit_device(dev)
        lease.granted.set()

    def _end(self, lease: MLease, how: str) -> None:
        dev = self.devices[lease.device]
        if lease.state == "queued":
            dev.queue.remove(lease)
            lease.state = how
            self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event=how)
            self._emit_device(dev)
            return
        if lease.state != "active":
            return
        lease.state, dev.lease, dev.status = how, None, "resetting"
        for run in self.runs.values():
            if run.lease_id == lease.lease_id and run.state not in ("failed", "stopped"):
                run.state = "stopped"
                self.emit("run", device=dev.id, run_id=run.run_id, state="stopped")
        self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event=how)
        self._emit_device(dev)
        self.spawn(self._handover(dev))

    async def _handover(self, dev: MDevice) -> None:
        await self.sleep(1.5)  # stop program -> reset to idle -> verifier confirm_idle
        if dev.status != "resetting":
            return
        if dev.queue:
            nxt = dev.queue.pop(0)
            self._grant(dev, nxt)
            for i, q in enumerate(dev.queue):
                self.emit("lease", device=dev.id, lease_id=q.lease_id, holder=q.holder, event="queued", position=i + 1)
        else:
            dev.status = "free"
            self._emit_device(dev, idle_confirmed=True)

    def renew(self, lease: MLease) -> None:
        lease.expires_at = min(time.time() + lease.ttl_s, lease.max_hold_until or 0)

    # ---- simulations ----------------------------------------------------------------------
    def _log(self, run: MRun, text: str) -> None:
        line = {"ts": time.time(), "text": text}
        run.logs.append(line)
        self.emit("log", device=run.device, run_id=run.run_id, ts=line["ts"], text=text)

    async def simulate_run(self, run: MRun) -> None:
        start = time.time()
        for state, delay in (("fetching", 0.3), ("building", 0.8), ("running", 0.0)):
            await self.sleep(delay)
            if run.state == "stopped":
                return
            run.state = state
            self.emit("run", device=run.device, run_id=run.run_id, state=state)
            self._log(run, f"{'' if UNLABELLED else '[mock] '}{state} {run.sha[:12]} {run.path}")
        run.build_time_s = round(time.time() - start, 2)
        self._log(run, "READY")

    async def simulate_verify(self, v: MVerify, assertions: list[dict[str, Any]], duration_s: float) -> None:
        await self.sleep(min(duration_s, 3.0))
        runs = [r for r in self.runs.values() if r.lease_id == v.lease_id]
        run = runs[-1] if runs else None
        good = run is not None and run.state == "running" and not run.sha.startswith("bad")
        v.results = [mock_result(a, run, good) for a in assertions]
        v.evidence_id = secrets.token_hex(16)
        lease = self.leases[v.lease_id]
        self.evidence[v.evidence_id] = {
            "evidence.json": json.dumps({
                "evidence_id": v.evidence_id, "rig_id": self.rig_id, "device": v.device, "holder": lease.holder,
                "farm_id": lease.holder.removeprefix("devin-"), "repo_url": "", "sha": run.sha if run else "",
                "run_id": run.run_id if run else None, "verify_id": v.verify_id, "started_at": time.time() - duration_s,
                "finished_at": time.time(), "results": v.results, "rig": {"temp_c": 50.0, "throttled": False},
                "verifier_version": "0.2.0" if UNLABELLED else "mock-0", "files": ["clip.gif", "frame-0.jpg"],
                "sample": not UNLABELLED, "mock": not UNLABELLED}).encode(),
            "frame-0.jpg": await camera_jpeg(), "clip.gif": CLIP_GIF,
        }
        v.state = "done"
        measured = [r for r in v.results if not r.get("self_reported")]
        passed = bool(measured) and all(r["passed"] for r in measured)
        self.devices[v.device].last_verdict = {"verify_id": v.verify_id, "passed": passed, "at": time.time()}
        self.emit("verify", device=v.device, verify_id=v.verify_id, state="done", results=v.results)
        self.emit("evidence", device=v.device, evidence_id=v.evidence_id, passed=passed)
        v.done.set()


def mock_result(a: dict[str, Any], run: MRun | None, good: bool) -> dict[str, Any]:
    kind, target = a.get("type", ""), a.get("target")
    expected = {k: v for k, v in a.items() if k not in ("type", "target")}
    base = {"type": kind, "target": target, "expected": expected, "self_reported": False}
    if kind == "log_contains":
        hit = run is not None and any(a.get("pattern", "") in line["text"] for line in run.logs)
        return {**base, "passed": hit, "measured": {"matched": hit}, "uncertainty": {}, "self_reported": True,
                "detail": "pattern found in run logs (self-reported)" if hit else "pattern not in run logs"}
    if run is None or run.state != "running":
        return {**base, "passed": False, "measured": {}, "uncertainty": {},
                "detail": "no program running on the device"}
    if kind == "led_blink":
        hz = float(a.get("hz", 1.0))
        got = hz if good else hz / 2
        return {**base, "passed": good, "measured": {"hz": round(got * (1 + random.uniform(-0.01, 0.01)), 3),
                                                       "duty": a.get("duty", 0.5)},
                "uncertainty": {"ms": 33}, "detail": "" if good else f"measured {got:.2f} Hz, expected {hz:.2f} Hz"}
    if kind == "led_sequence":
        steps = [dict(s, ms=int(s.get("ms", 0)) + random.randint(-4, 4)) for s in a.get("steps", [])]
        if not good and len(steps) > 1:
            steps[1]["on"] = sorted(set(steps[1].get("on", [])) | {0})
        return {**base, "passed": good, "measured": {"steps": steps}, "uncertainty": {"ms": 33},
                "detail": "" if good else "step 2: LED 0 still on"}
    if kind == "led_state":
        want = a.get("state", "on")
        got = want if good else ("off" if want == "on" else "on")
        return {**base, "passed": good, "measured": {"state": got}, "uncertainty": {"frames": 1},
                "detail": "" if good else f"LED is {got}"}
    if kind == "matrix_frame" and isinstance(a.get("ascii"), list):
        grid = [str(r) for r in a["ascii"]]
        seen = grid if good else ["." * len(grid[0])] + grid[:-1]  # wrong program: image one row low
        return {**base, "passed": good, "measured": {"ascii": seen, "cells_off": 0 if good else 14},
                "uncertainty": {"cells": 1}, "detail": "" if good else "14 cells differ (tolerance 2): image one row low"}
    return {**base, "passed": good, "measured": expected if good else {}, "uncertainty": {"cells": 1},
            "detail": "" if good else f"{kind}: camera saw something else"}


async def camera_jpeg() -> bytes:
    """Live frame from FARM_MOCK_CAMERA_URL (the rig's verifier /snapshot) when set, else the bundled sample."""
    url = os.environ.get("FARM_MOCK_CAMERA_URL")
    if url:
        try:
            async with httpx.AsyncClient(timeout=2.0) as http:
                r = await http.get(url)
                if r.status_code == 200:
                    return r.content
        except httpx.HTTPError:
            pass
    return FRAME_JPEG


# ---- HTTP ---------------------------------------------------------------------------------

def create_rig_app(rig: MockRig) -> FastAPI:
    app = FastAPI(title=f"mock rigd {rig.rig_id}", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RigAPIError)
    async def _err(_: Request, exc: RigAPIError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code, "message": exc.message, "next": exc.next_call}},
                            status_code=exc.status)

    def node(request: Request) -> str:
        n = request.headers.get("X-Mock-Node", "")
        if not n:
            raise RigAPIError(403, "not_on_tailnet", "caller has no tailnet identity (X-Mock-Node)")
        return n

    def device(dev_id: str) -> MDevice:
        dev = rig.devices.get(dev_id)
        if dev is None:
            raise RigAPIError(404, "unknown", f"no device {dev_id}", "GET /v1/devices")
        return dev

    def lease_for(request: Request, lease_id: str, token: bool = True) -> MLease:
        who = node(request)
        lease = rig.leases.get(lease_id)
        if lease is None:
            raise RigAPIError(404, "unknown", f"no lease {lease_id}", "POST /v1/leases")
        if lease.holder != who:
            raise RigAPIError(403, "not_holder", "lease belongs to another node", "POST /v1/leases")
        if token:
            if lease.state != "active" or request.headers.get("X-Fencing-Token") != str(lease.token):
                raise RigAPIError(403, "stale_token", "fencing token is not current", "POST /v1/leases")
            rig.renew(lease)
            rig.emit("lease", device=lease.device, lease_id=lease.lease_id, holder=lease.holder, event="renewed",
                     expires_at=lease.expires_at)
        return lease

    def require_team(request: Request) -> str:
        who = node(request)
        if who.startswith("devin-"):
            raise RigAPIError(403, "not_team", "admin is team/control only")
        return who

    # C1 -------------------------------------------------------------------------------------
    @app.get("/v1/rig")
    async def get_rig(request: Request) -> dict[str, Any]:
        node(request)
        return rig.rig_json()

    @app.get("/v1/devices")
    async def get_devices(request: Request) -> list[dict[str, Any]]:
        node(request)
        return [rig.device_json(d) for d in rig.devices.values()]

    @app.get("/v1/devices/{dev_id}/describe", response_class=PlainTextResponse)
    async def describe(dev_id: str, request: Request) -> str:
        node(request)
        dev = device(dev_id)
        return (f"# {dev.id} ({dev.type}, mock)\n\nOutputs: {', '.join(dev.outputs)}\n\n"
                "Mock verifier: SHAs starting with `bad` misbehave physically; logs still print READY.\n")

    @app.post("/v1/leases")
    async def acquire(request: Request) -> JSONResponse:
        who = node(request)
        body = await request.json()
        dev = device(str(body.get("device", "")))
        if rig.maintenance:
            raise RigAPIError(409, "maintenance", "rig is in maintenance", "retry later")
        if dev.status == "offline":
            raise RigAPIError(409, "device_offline", f"{dev.id} is offline", "GET /v1/devices")
        active = sum(1 for le in rig.leases.values() if le.holder == who and le.state == "active")
        if active >= MAX_ACTIVE_PER_NODE:
            raise RigAPIError(409, "busy", f"node already holds {active} leases", "POST /v1/leases/{id}/release")
        ttl = min(float(body.get("ttl_s", 300)), 900.0)
        wait = min(float(body.get("wait_s", 20)), 25.0)
        lease = MLease(lease_id=f"l-{secrets.token_hex(6)}", device=dev.id, holder=who, ttl_s=ttl)
        rig.leases[lease.lease_id] = lease
        if dev.status == "free" and not dev.queue:
            rig._grant(dev, lease)
        else:
            dev.queue.append(lease)
            rig.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=who, event="queued",
                     position=len(dev.queue))
            rig._emit_device(dev)
            try:
                await asyncio.wait_for(lease.granted.wait(), timeout=wait * rig.speed)
            except asyncio.TimeoutError:
                pass
        if lease.state == "active":
            return JSONResponse({"lease_id": lease.lease_id, "device": dev.id, "token": lease.token,
                                 "expires_at": lease.expires_at, "max_hold_until": lease.max_hold_until})
        return JSONResponse({"lease_id": lease.lease_id, "queued": True,
                             "position": dev.queue.index(lease) + 1}, status_code=202)

    @app.get("/v1/leases/{lease_id}")
    async def lease_status(lease_id: str, request: Request) -> dict[str, Any]:
        lease = lease_for(request, lease_id, token=False)
        out = rig.lease_json(lease)
        out.pop("lease_id", None)
        out.pop("device", None)
        return out

    @app.post("/v1/leases/{lease_id}/renew")
    async def renew(lease_id: str, request: Request) -> dict[str, Any]:
        lease = lease_for(request, lease_id)
        return {"expires_at": lease.expires_at}

    @app.post("/v1/leases/{lease_id}/run", status_code=202)
    async def run(lease_id: str, request: Request) -> dict[str, Any]:
        lease = lease_for(request, lease_id)
        body = await request.json()
        r = MRun(run_id=f"r-{secrets.token_hex(6)}", device=lease.device, lease_id=lease_id,
                 sha=str(body.get("sha", "")), path=str(body.get("path", "")))
        for old in rig.runs.values():
            if old.lease_id == lease_id and old.state not in ("failed", "stopped"):
                old.state = "stopped"
        rig.runs[r.run_id] = r
        rig.emit("run", device=r.device, run_id=r.run_id, state="queued")
        rig.spawn(rig.simulate_run(r))
        return {"run_id": r.run_id}

    @app.get("/v1/runs/{run_id}")
    async def run_status(run_id: str, request: Request) -> dict[str, Any]:
        node(request)
        r = rig.runs.get(run_id)
        if r is None:
            raise RigAPIError(404, "unknown", f"no run {run_id}")
        out: dict[str, Any] = {"state": r.state}
        if r.build_time_s is not None:
            out["build_time_s"] = r.build_time_s
        return out

    @app.get("/v1/runs/{run_id}/logs")
    async def run_logs(run_id: str, request: Request, since: float = 0.0) -> dict[str, Any]:
        node(request)
        r = rig.runs.get(run_id)
        if r is None:
            raise RigAPIError(404, "unknown", f"no run {run_id}")
        lines = [ln for ln in r.logs if ln["ts"] > since]
        return {"lines": lines, "next": lines[-1]["ts"] if lines else since}

    @app.post("/v1/leases/{lease_id}/verify", status_code=202)
    async def verify(lease_id: str, request: Request) -> dict[str, Any]:
        lease = lease_for(request, lease_id)
        body = await request.json()
        v = MVerify(verify_id=f"v-{secrets.token_hex(6)}", device=lease.device, lease_id=lease_id)
        rig.verifies[v.verify_id] = v
        rig.emit("verify", device=v.device, verify_id=v.verify_id, state="pending")
        rig.spawn(rig.simulate_verify(v, list(body.get("assertions") or []),
                                      min(float(body.get("duration_s", 10)), 30.0)))
        return {"verify_id": v.verify_id}

    @app.get("/v1/verify/{verify_id}")
    async def verify_status(verify_id: str, request: Request, wait: float = 0.0) -> dict[str, Any]:
        node(request)
        v = rig.verifies.get(verify_id)
        if v is None:
            raise RigAPIError(404, "unknown", f"no verify {verify_id}")
        if wait > 0 and not v.done.is_set():
            try:
                await asyncio.wait_for(v.done.wait(), timeout=min(wait, 25.0))
            except asyncio.TimeoutError:
                pass
        out: dict[str, Any] = {"state": v.state}
        if v.state == "done":
            out["results"] = v.results
            out["evidence"] = {"id": v.evidence_id, "local_url": f"/v1/evidence/{v.evidence_id}"}
        return out

    @app.post("/v1/leases/{lease_id}/release")
    async def release(lease_id: str, request: Request) -> dict[str, Any]:
        lease = lease_for(request, lease_id, token=False)
        if lease.state == "active" and request.headers.get("X-Fencing-Token") != str(lease.token):
            raise RigAPIError(403, "stale_token", "fencing token is not current", "POST /v1/leases")
        rig._end(lease, "released")
        return {"ok": True}

    # C3 -------------------------------------------------------------------------------------
    @app.get("/v1/state")
    async def state(request: Request) -> dict[str, Any]:
        node(request)
        return rig.state_json()

    @app.get("/v1/events")
    async def events(request: Request) -> StreamingResponse:
        node(request)
        q: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()
        rig._subs.add(q)

        async def gen() -> Any:
            try:
                while True:
                    try:
                        name, data = await asyncio.wait_for(q.get(), timeout=10)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield encode_sse(name, data)
            finally:
                rig._subs.discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/v1/devices/{dev_id}/snapshot.jpg")
    async def snapshot(dev_id: str, request: Request) -> Response:
        node(request)
        device(dev_id)
        return Response(await camera_jpeg(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/v1/evidence/{evidence_id}")
    async def evidence(evidence_id: str, request: Request) -> Response:
        node(request)
        bundle = rig.evidence.get(evidence_id)
        if bundle is None:
            raise RigAPIError(404, "unknown", "no such evidence")
        return Response(bundle["evidence.json"], media_type="application/json")

    @app.get("/v1/evidence/{evidence_id}/{name}")
    async def evidence_file(evidence_id: str, name: str, request: Request) -> Response:
        node(request)
        data = rig.evidence.get(evidence_id, {}).get(name)
        if data is None:
            raise RigAPIError(404, "unknown", "no such file")
        media = {"jpg": "image/jpeg", "gif": "image/gif", "json": "application/json"}.get(name.rsplit(".", 1)[-1])
        return Response(data, media_type=media or "application/octet-stream")

    @app.post("/v1/admin/maintenance")
    async def maintenance(request: Request) -> dict[str, Any]:
        require_team(request)
        rig.maintenance = bool((await request.json()).get("on"))
        rig.emit("rig_health", **rig.health())
        return {"maintenance": rig.maintenance}

    @app.post("/v1/admin/devices/{dev_id}/reset")
    async def reset(dev_id: str, request: Request) -> dict[str, Any]:
        require_team(request)
        dev = device(dev_id)
        if dev.lease:
            rig._end(dev.lease, "revoked")
        elif dev.status != "resetting":
            dev.status = "resetting"
            rig._emit_device(dev)
            rig.spawn(rig._handover(dev))
        return {"ok": True}

    @app.post("/v1/admin/leases/{lease_id}/revoke")
    async def revoke(lease_id: str, request: Request) -> dict[str, Any]:
        require_team(request)
        lease = rig.leases.get(lease_id)
        if lease is None:
            raise RigAPIError(404, "unknown", f"no lease {lease_id}")
        rig._end(lease, "revoked")
        return {"ok": True}

    return app
