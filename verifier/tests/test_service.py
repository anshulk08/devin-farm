"""C5 HTTP service on a synthetic camera: health, observe pass/fail, honest failures, idle, snapshot, stream, evidence."""

import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from farm_verifier import grid, synth
from farm_verifier.hub import FrameHub
from farm_verifier.matrix import calibrate
from farm_verifier.service import ObserveReq, Verifier, build_app

IMAGES = Path(__file__).resolve().parents[1] / "images"
LOGO = grid.load(IMAGES / "devin-hexes.txt")
COG = grid.load(IMAGES / "cognition-logo.txt")
CAL_IMG = grid.load(IMAGES / "calibrate.txt")


def idle_grid(centre_on: bool) -> np.ndarray:
    g = np.zeros((8, 13), bool)
    for r, c in ((0, 0), (0, 12), (7, 0), (7, 12)):
        g[r, c] = True
    g[3, 6] = centre_on
    return g


class FakeCam:
    """Renders what `shown()` says the matrix shows, at ~30 fps."""

    def __init__(self, shown, fps=30.0, fail_after=None):
        self.shown, self.gap, self.n, self.fail_after = shown, 1 / fps, 0, fail_after
        self.rng = np.random.default_rng(3)

    def read_bgr(self):
        time.sleep(self.gap)
        self.n += 1
        if self.fail_after is not None and self.n > self.fail_after:
            raise RuntimeError("unplugged")
        g = synth.render(self.shown(), rng=self.rng)
        return time.monotonic(), cv2.merge([g, g, g])

    def close(self):
        pass


class Rig:
    def __init__(self, tmp_path, shown=None, opener=None, calibrated=True):
        self.grid = LOGO
        self.shown = shown or (lambda: self.grid)
        self.hub = FrameHub(opener or (lambda: FakeCam(self.shown)), retry_s=0.2).start()
        self.v = Verifier(self.hub, tmp_path / "state", tmp_path / "ev")
        if calibrated:
            cal = calibrate([img for _, img in synth.clip(CAL_IMG, n=8)])
            cal.save(self.v.cal_path("unoq-1"))
        self.client = TestClient(build_app(self.v))
        deadline = time.monotonic() + 3
        while self.hub.latest() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.6)  # let the fps estimate fill

    def close(self):
        self.hub.stop()


@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    yield r
    r.close()


def matrix_assertion(g, hold=1.0):
    return {"type": "matrix_frame", "target": "unoq.matrix", "ascii": grid.to_ascii(g), "tol_cells": 2, "hold_s": hold}


def observe(rig, assertions, duration=2.0):
    r = rig.client.post("/observe", json={"device": "unoq-1", "assertions": assertions, "duration_s": duration, "run_id": "r1"})
    assert r.status_code == 200
    return r.json()


def test_health_reports_fps_age_and_calibration(rig):
    h = rig.client.get("/health").json()
    assert h["ok"] and h["fps"] > 10 and h["last_frame_age_s"] < 1 and h["calibrated"]["unoq-1"] is True


def test_observe_pass_and_c7_evidence(rig):
    body = observe(rig, [matrix_assertion(LOGO)])
    res = body["results"][0]
    assert res["passed"], res["detail"]
    assert res["measured"]["ascii"] == grid.to_ascii(LOGO)
    ev = Path(body["evidence_dir"])
    names = {p.name for p in ev.iterdir()}
    assert "frame-0.jpg" in names and "clip.mp4" in names and "clip.gif" in names
    assert (ev / "clip.gif").stat().st_size < 3_000_000 and (ev / "clip.mp4").stat().st_size > 1000
    assert cv2.imread(str(ev / "frame-0.jpg")) is not None


def test_observe_wrong_image_fails(rig):
    res = observe(rig, [matrix_assertion(COG)])["results"][0]
    assert not res["passed"] and "cells differ" in res["detail"]


def test_result_count_matches_assertions(rig):
    body = observe(rig, [matrix_assertion(LOGO), {"type": "log_contains", "pattern": "x"}, matrix_assertion(COG)])
    assert [r["passed"] for r in body["results"]] == [True, False, False]


@pytest.mark.parametrize("a", [
    {"type": "matrix_text", "target": "unoq.matrix", "text": "DEVIN"},
    {"type": "led_blink", "target": "unoq.led", "hz": 2.0},
    {"type": "bogus", "target": "unoq.x"},
])
def test_unimplemented_or_unmeasurable_assertions_never_pass(rig, a):
    res = observe(rig, [a], duration=1.0)["results"][0]
    assert res["passed"] is False and res["detail"].startswith("cannot verify")


def test_wrong_device_target_fails(rig):
    a = {"type": "led_state", "target": "pico.led", "state": "on"}
    assert not observe(rig, [a], duration=1.0)["results"][0]["passed"]


def test_uncalibrated_fails_with_reason(tmp_path):
    r = Rig(tmp_path, calibrated=False)
    try:
        res = observe(r, [matrix_assertion(LOGO)], duration=1.0)["results"][0]
        assert not res["passed"] and "not calibrated" in res["detail"]
        assert not r.client.get("/health").json()["calibrated"]["unoq-1"]
        idle = r.client.post("/confirm_idle", json={"device": "unoq-1"}).json()
        assert not idle["ok"] and "not calibrated" in idle["detail"]
    finally:
        r.close()


def test_camera_missing_fails_honestly(tmp_path):
    def broken():
        raise RuntimeError("no camera named like ('BRIO',)")

    r = Rig(tmp_path, opener=broken)
    try:
        h = r.client.get("/health").json()
        assert h["ok"] is False and "no camera" in h["error"]
        res = observe(r, [matrix_assertion(LOGO)])["results"][0]
        assert not res["passed"] and "camera unavailable" in res["detail"]
        assert r.client.get("/snapshot").status_code == 503
        assert r.client.post("/confirm_idle", json={"device": "unoq-1"}).json()["ok"] is False
        assert r.client.post("/calibrate", json={"device": "unoq-1"}).json()["ok"] is False
    finally:
        r.close()


def dies_once(fail_after):
    opened = []

    def opener():
        if opened:
            raise RuntimeError("camera gone")
        opened.append(1)
        return FakeCam(lambda: LOGO, fail_after=fail_after)
    return opener


def test_stale_frames_fail(tmp_path):
    r = Rig(tmp_path, opener=dies_once(15))
    try:
        time.sleep(2.6)  # camera died; last frame is now stale
        h = r.client.get("/health").json()
        assert h["ok"] is False
        res = observe(r, [matrix_assertion(LOGO)], duration=1.0)["results"][0]
        assert not res["passed"] and "camera" in res["detail"]
    finally:
        r.close()


def test_camera_dying_mid_observation_fails(tmp_path):
    r = Rig(tmp_path, opener=dies_once(45))
    try:
        res = observe(r, [matrix_assertion(LOGO)], duration=3.5)["results"][0]
        assert not res["passed"]
    finally:
        r.close()


def test_confirm_idle_passes_on_idle_pattern(tmp_path):
    t0 = time.monotonic()
    r = Rig(tmp_path, shown=lambda: idle_grid(int((time.monotonic() - t0) // 1) % 2 == 0))
    try:
        out = r.client.post("/confirm_idle", json={"device": "unoq-1"}).json()
        assert out["ok"], out
        assert out["measured"]["centre_transitions"] >= 3
    finally:
        r.close()


@pytest.mark.parametrize("name", ["logo", "frozen", "blank"])
def test_confirm_idle_fails_on_other_patterns(tmp_path, name):
    shown = {"logo": lambda: LOGO, "frozen": lambda: idle_grid(True), "blank": lambda: np.zeros((8, 13), bool)}[name]
    r = Rig(tmp_path, shown=shown)
    try:
        out = r.client.post("/confirm_idle", json={"device": "unoq-1"}).json()
        assert out["ok"] is False and out["detail"]
    finally:
        r.close()


def test_calibrate_endpoint_from_calibration_image(tmp_path):
    r = Rig(tmp_path, shown=lambda: CAL_IMG, calibrated=False)
    try:
        out = r.client.post("/calibrate", json={"device": "unoq-1"}).json()
        assert out["ok"], out
        assert r.client.get("/health").json()["calibrated"]["unoq-1"] is True
    finally:
        r.close()


def test_calibrate_fails_when_image_not_showing(tmp_path):
    r = Rig(tmp_path, shown=lambda: np.zeros((8, 13), bool), calibrated=False)
    try:
        out = r.client.post("/calibrate", json={"device": "unoq-1"}).json()
        assert out["ok"] is False and out["detail"]
    finally:
        r.close()


def test_snapshot_is_roi_cropped_jpeg(rig):
    r = rig.client.get("/snapshot", params={"device": "unoq-1"})
    assert r.headers["content-type"] == "image/jpeg"
    img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[1] < 400 and img.shape[0] < 150


def test_stream_is_mjpeg_at_most_10fps(rig):
    n, t0 = 0, time.monotonic()
    with rig.client.stream("GET", "/stream", params={"device": "unoq-1"}) as r:
        assert r.headers["content-type"].startswith("multipart/x-mixed-replace")
        buf = b""
        for chunk in r.iter_bytes():
            buf += chunk
            n = buf.count(b"--frame")
            if time.monotonic() - t0 > 1.5:
                break
    rate = n / (time.monotonic() - t0)
    assert 3 <= rate <= 11, rate


def test_observe_duration_is_capped(rig):
    body = rig.client.post("/observe", json={"device": "unoq-1", "assertions": [], "duration_s": 999}).json()
    assert body["results"] == []
