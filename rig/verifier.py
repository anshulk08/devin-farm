"""Verifier clients. MockVerifier = lane C's deterministic rule; HttpVerifier = C5 client that fails
honestly (passed:false, 'verifier unavailable') when the service is down. Never passes by default."""
from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx


def split_assertions(assertions: list[dict[str, Any]]) -> tuple[list[tuple[int, dict]], list[tuple[int, dict]]]:
    """(log_contains, to_verifier), each with original index. log_contains is evaluated by rigd (C6)."""
    logs = [(i, a) for i, a in enumerate(assertions) if a.get("type") == "log_contains"]
    rest = [(i, a) for i, a in enumerate(assertions) if a.get("type") != "log_contains"]
    return logs, rest


def unavailable_result(a: dict[str, Any], why: str) -> dict[str, Any]:
    expected = {k: v for k, v in a.items() if k not in ("type", "target")}
    return {"type": a.get("type", ""), "target": a.get("target"), "passed": False, "measured": {},
            "expected": expected, "uncertainty": {}, "self_reported": False,
            "detail": f"verifier unavailable: {why}"}


class MockVerifier:
    """Mock rule: a run whose SHA starts with 'bad' misbehaves physically; anything else passes."""
    name = "mock"
    evidence_dir: str | None = None

    async def health(self) -> dict[str, Any]:
        return {"ok": True, "fps": 30.0, "last_frame_age_s": 0.03, "calibrated": {}}

    async def confirm_idle(self, device: str) -> dict[str, Any]:
        return {"ok": True, "detail": "mock idle", "measured": {}}

    async def observe(self, device: str, assertions: list[dict], duration_s: float, run_id: str,
                      run_state: str | None, run_sha: str, speed: float) -> dict[str, Any]:
        await asyncio.sleep(min(duration_s, 3.0) * speed)
        good = run_state == "running" and not run_sha.startswith("bad")
        return {"results": [mock_result(a, run_state == "running", good) for a in assertions],
                "evidence_dir": None}

    async def snapshot(self, device: str) -> bytes | None:
        return None


def mock_result(a: dict[str, Any], running: bool, good: bool) -> dict[str, Any]:
    kind, target = a.get("type", ""), a.get("target")
    expected = {k: v for k, v in a.items() if k not in ("type", "target")}
    base = {"type": kind, "target": target, "expected": expected, "self_reported": False}
    if not running:
        return {**base, "passed": False, "measured": {}, "uncertainty": {}, "detail": "no program running on the device"}
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
    return {**base, "passed": good, "measured": expected if good else {}, "uncertainty": {"cells": 1},
            "detail": "" if good else f"{kind}: camera saw something else"}


class HttpVerifier:
    """C5 client. Every failure becomes a failed result with a reason; never a pass."""
    name = "http"

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base, timeout=httpx.Timeout(10.0, read=60.0))

    async def health(self) -> dict[str, Any]:
        try:
            r = await self.http.get("/health", timeout=3.0)
            r.raise_for_status()
            return {**r.json(), "ok": bool(r.json().get("ok"))}
        except Exception as e:  # noqa: BLE001 - any failure means offline
            return {"ok": False, "error": str(e) or type(e).__name__}

    async def confirm_idle(self, device: str) -> dict[str, Any]:
        try:
            r = await self.http.post("/confirm_idle", json={"device": device}, timeout=10.0)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": f"verifier unavailable: {str(e) or type(e).__name__}", "measured": {}}

    async def observe(self, device: str, assertions: list[dict], duration_s: float, run_id: str,
                      run_state: str | None, run_sha: str, speed: float) -> dict[str, Any]:
        if not assertions:
            return {"results": [], "evidence_dir": None}
        try:
            r = await self.http.post("/observe", json={"device": device, "assertions": assertions,
                                                       "duration_s": duration_s, "run_id": run_id},
                                     timeout=duration_s + 45.0)
            r.raise_for_status()
            body = r.json()
            results = body.get("results")
            if not isinstance(results, list) or len(results) != len(assertions):
                raise ValueError("verifier returned a malformed result list")
            return {"results": results, "evidence_dir": body.get("evidence_dir")}
        except Exception as e:  # noqa: BLE001
            why = str(e) or type(e).__name__
            return {"results": [unavailable_result(a, why) for a in assertions], "evidence_dir": None}

    async def snapshot(self, device: str) -> bytes | None:
        try:
            r = await self.http.get("/snapshot", params={"device": device}, timeout=5.0)
            r.raise_for_status()
            return r.content
        except Exception:  # noqa: BLE001
            return None
