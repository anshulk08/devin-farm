"""Rig engine: leases, FIFO queue, fencing tokens, hand-over, runs, verify, evidence, events (C1-C4).

Derived from lane C's mock rig (leases/queue/fencing/events) with pluggable drivers and verifier.
State is in memory except fencing tokens (SQLite, so a token is never reused after a restart).
Restart ends every lease by design: every device is reset to idle before any grant (C2).
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import secrets
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import RigConfig
from .drivers.base import DeployError, Driver, RunCtx
from .fetch import fetch_source, make_workdir
from .verifier import split_assertions, unavailable_result

MAX_ACTIVE_PER_NODE = 2
HARD_CAP_S = 1800.0
QUEUE_POLL_TIMEOUT_S = 30.0
HOLDER_ABSENT_S = 30.0
LOG_RATE_PER_S = 20
LOG_KEEP = 2000


class RigAPIError(Exception):
    def __init__(self, status: int, code: str, message: str, next_call: str = ""):
        super().__init__(message)
        self.status, self.code, self.message, self.next_call = status, code, message, next_call


@dataclass
class Lease:
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
    last_poll: float = field(default_factory=time.time)
    last_renew_event: float = 0.0
    granted: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class Dev:
    id: str
    type: str
    driver: Driver
    order: int = 0
    status: str = "resetting"
    reason: str | None = None
    token: int = 0
    lease: Lease | None = None
    queue: list[Lease] = field(default_factory=list)
    last_verdict: dict[str, Any] | None = None
    handover: asyncio.Task | None = None


@dataclass
class Run:
    run_id: str
    device: str
    lease_id: str
    repo_url: str
    sha: str
    path: str
    state: str = "queued"
    build_time_s: float | None = None
    error: dict[str, Any] | None = None
    logs: list[dict[str, Any]] = field(default_factory=list)
    task: asyncio.Task | None = None
    log_budget: float = float(LOG_RATE_PER_S)
    log_stamp: float = field(default_factory=time.monotonic)


@dataclass
class Verify:
    verify_id: str
    device: str
    lease_id: str
    state: str = "pending"
    results: list[dict[str, Any]] | None = None
    evidence_id: str | None = None
    error: str | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


class TokenStore:
    """Monotonic fencing token per device, persisted in SQLite (WAL)."""

    def __init__(self, path: Path | None):
        self.db = sqlite3.connect(str(path) if path else ":memory:", check_same_thread=False)
        if path:
            self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS tokens (device TEXT PRIMARY KEY, token INTEGER NOT NULL)")
        self.db.commit()

    def get(self, device: str) -> int:
        row = self.db.execute("SELECT token FROM tokens WHERE device=?", (device,)).fetchone()
        return int(row[0]) if row else 0

    def bump(self, device: str) -> int:
        self.db.execute("INSERT INTO tokens(device, token) VALUES(?, 1) "
                        "ON CONFLICT(device) DO UPDATE SET token = token + 1", (device,))
        self.db.commit()
        return self.get(device)


class Rig:
    def __init__(self, cfg: RigConfig, drivers: dict[str, Driver], verifier: Any, identity: Any,
                 state_dir: Path, mock: bool, speed: float = 1.0, health_interval_s: float = 5.0):
        self.cfg, self.rig_id = cfg, cfg.rig_id
        self.verifier, self.identity, self.mock, self.speed = verifier, identity, mock, speed
        self.state_dir = state_dir
        self.evidence_dir = state_dir / "evidence"
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        self.tokens = TokenStore(None if mock else state_dir / "rigd.sqlite")
        self.devices: dict[str, Dev] = {}
        for d in cfg.devices:
            drv = drivers[d["id"]]
            dev = Dev(d["id"], d["type"], drv, int(d.get("order", 0)))
            dev.token = self.tokens.get(dev.id)
            self.devices[dev.id] = dev
        self.leases: dict[str, Lease] = {}
        self.runs: dict[str, Run] = {}
        self.verifies: dict[str, Verify] = {}
        self.maintenance = False
        self.verifier_ok = mock
        self.camera_ok = mock
        self.health_interval_s = health_interval_s
        self._subs: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._absent: dict[str, float] = {}
        self._snap_at: dict[str, float] = {}

    # ---- infrastructure -------------------------------------------------------------------
    def emit(self, name: str, **data: Any) -> None:
        data.update(rig_id=self.rig_id, ts=time.time())
        for q in list(self._subs):
            q.put_nowait((name, data))

    def spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds * self.speed)

    def start(self) -> None:
        for dev in self.devices.values():
            dev.handover = self.spawn(self._handover(dev, startup=True))
        self.spawn(self._health_loop())
        self.spawn(self._maintenance_loop())

    async def stop(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for dev in self.devices.values():
            try:
                await dev.driver.stop()
            except Exception:  # noqa: BLE001
                pass

    # ---- health ---------------------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        if self.mock:
            return {"temp_c": round(48 + random.random() * 4, 1), "load1": round(0.4 + random.random() * 0.3, 2),
                    "mem_free_mb": 2400, "throttled": False, "camera_ok": True, "verifier_online": True}
        temp = None
        for zone in sorted(Path("/sys/class/thermal").glob("thermal_zone*/temp")):
            try:
                v = int(zone.read_text()) / 1000.0
                temp = v if temp is None else max(temp, v)
            except (OSError, ValueError, TypeError):
                pass
        mem = None
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    mem = int(line.split()[1]) // 1024
        except OSError:
            pass
        # `throttled`: no portable Jetson signal wired yet; reported false (not measured).
        return {"temp_c": None if temp is None else round(temp, 1), "load1": round(os.getloadavg()[0], 2),
                "mem_free_mb": mem, "throttled": False, "camera_ok": self.camera_ok,
                "verifier_online": self.verifier_ok}

    def model(self) -> str:
        if self.mock:
            return "mock Jetson"
        try:
            return Path("/proc/device-tree/model").read_text().strip("\x00\n ")
        except OSError:
            return "unknown"

    async def _health_loop(self) -> None:
        while True:
            if not self.mock:
                h = await self.verifier.health()
                self.verifier_ok = bool(h.get("ok"))
                age = h.get("last_frame_age_s")
                self.camera_ok = self.verifier_ok and (age is None or age < 5.0)
            self.emit("rig_health", **self.health())
            await asyncio.sleep(self.health_interval_s)

    # ---- periodic: expiry, queue drop, holder-offline, device presence ----------------------
    async def _maintenance_loop(self) -> None:
        last_presence = 0.0
        last_nodes = 0.0
        while True:
            now = time.time()
            for lease in list(self.leases.values()):
                if lease.state == "active" and (now > (lease.expires_at or 0) or now > (lease.max_hold_until or 0)):
                    self._end(lease, "expired")
                elif lease.state == "queued" and now - lease.last_poll > QUEUE_POLL_TIMEOUT_S:
                    self._end(lease, "expired")
            if now - last_nodes >= 5.0:
                last_nodes = now
                await self._check_holders(now)
            if now - last_presence >= 3.0:
                last_presence = now
                await self._check_presence()
            await asyncio.sleep(0.25)

    async def _check_holders(self, now: float) -> None:
        online = await self.identity.online_nodes()
        if online is None:
            return
        for lease in list(self.leases.values()):
            if lease.state != "active":
                continue
            if lease.holder in online:
                self._absent.pop(lease.holder, None)
            elif now - self._absent.setdefault(lease.holder, now) >= HOLDER_ABSENT_S:
                self._end(lease, "expired")

    async def _check_presence(self) -> None:
        for dev in list(self.devices.values()):
            if dev.status in ("resetting",):
                continue
            present, why = await dev.driver.discover()
            if dev.status == "offline" and present and (dev.reason or "").startswith("not_present"):
                self._begin_handover(dev)
            elif dev.status in ("free", "leased") and not present:
                if dev.lease:
                    self._end(dev.lease, "revoked")
                self._set_offline(dev, why)

    # ---- views ----------------------------------------------------------------------------
    def device_json(self, dev: Dev) -> dict[str, Any]:
        d: dict[str, Any] = {"id": dev.id, "type": dev.type, "status": dev.status, "queue_depth": len(dev.queue),
                             "outputs": dev.driver.outputs, "describe_url": f"/v1/devices/{dev.id}/describe",
                             "order": dev.order}
        if dev.lease:
            d["holder"] = dev.lease.holder
        if dev.status == "offline" and dev.reason:
            d["reason"] = dev.reason
        return d

    def rig_json(self) -> dict[str, Any]:
        return {"rig_id": self.rig_id, "online": True, "model": self.model(), **self.health(),
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
        return {"rig": self.rig_json(), "devices": devices,
                "camera": {"ok": self.camera_ok, "fps": 30.0 if self.mock else None,
                           "last_frame_age_s": 0.03 if self.mock else None}}

    def lease_json(self, lease: Lease) -> dict[str, Any]:
        d: dict[str, Any] = {"lease_id": lease.lease_id, "device": lease.device, "state": lease.state}
        if lease.state == "queued":
            d["position"] = self.devices[lease.device].queue.index(lease) + 1
        if lease.state == "active":
            d.update(token=lease.token, expires_at=lease.expires_at, max_hold_until=lease.max_hold_until)
        return d

    # ---- lease engine (C2) ----------------------------------------------------------------
    def emit_device(self, dev: Dev, **extra: Any) -> None:
        data: dict[str, Any] = {"device": dev.id, "status": dev.status,
                                "holder": dev.lease.holder if dev.lease else None, "queue_depth": len(dev.queue)}
        if dev.status == "offline" and dev.reason:
            data["reason"] = dev.reason
        self.emit("device", **data, **extra)

    def _set_offline(self, dev: Dev, reason: str) -> None:
        dev.status, dev.reason = "offline", reason
        self.emit_device(dev)

    def _grant(self, dev: Dev, lease: Lease) -> None:
        now = time.time()
        dev.token = self.tokens.bump(dev.id)
        lease.state, lease.token, lease.granted_at = "active", dev.token, now
        lease.expires_at, lease.max_hold_until = now + lease.ttl_s, now + HARD_CAP_S
        dev.lease, dev.status, dev.reason = lease, "leased", None
        self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event="granted",
                  token=lease.token, expires_at=lease.expires_at)
        self.emit_device(dev)
        lease.granted.set()

    def _end(self, lease: Lease, how: str) -> None:
        dev = self.devices[lease.device]
        if lease.state == "queued":
            dev.queue.remove(lease)
            lease.state = how
            self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event=how)
            self.emit_device(dev)
            self._requeue_positions(dev)
            return
        if lease.state != "active":
            return
        lease.state, dev.lease, dev.status = how, None, "resetting"
        for run in self.runs.values():
            if run.lease_id == lease.lease_id and run.state not in ("failed", "stopped"):
                run.state = "stopped"
                if run.task:
                    run.task.cancel()
                self.emit("run", device=dev.id, run_id=run.run_id, state="stopped")
        self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=lease.holder, event=how)
        self.emit_device(dev)
        self._begin_handover(dev, already_resetting=True)

    def _requeue_positions(self, dev: Dev) -> None:
        for i, q in enumerate(dev.queue):
            self.emit("lease", device=dev.id, lease_id=q.lease_id, holder=q.holder, event="queued", position=i + 1)

    def _begin_handover(self, dev: Dev, already_resetting: bool = False) -> None:
        if dev.handover and not dev.handover.done():
            return
        if not already_resetting:
            dev.status, dev.reason = "resetting", None
            self.emit_device(dev)
        dev.handover = self.spawn(self._handover(dev))

    async def _handover(self, dev: Dev, startup: bool = False) -> None:
        """stop program -> reset to idle -> verifier confirm_idle -> grant the next waiter."""
        try:
            present, why = await dev.driver.discover()
            if not present:
                self._set_offline(dev, why)
                return
            await dev.driver.stop()
            if startup and dev.driver.mock:
                pass
            else:
                await dev.driver.reset_to_idle()
            idle = await self.verifier.confirm_idle(dev.id)
            confirmed = bool(idle.get("ok"))
            if not confirmed:
                v = await self.verifier.health()
                if v.get("ok"):
                    self._set_offline(dev, f"idle_unconfirmed: {idle.get('detail', 'verifier says not idle')}")
                    return
                # verifier service not reachable: cannot confirm; the device is usable but unconfirmed
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self._set_offline(dev, f"reset_failed: {str(e) or type(e).__name__}")
            return
        if dev.status != "resetting":
            return
        if dev.queue and not self.maintenance:
            nxt = dev.queue.pop(0)
            self._grant(dev, nxt)
            self._requeue_positions(dev)
        else:
            dev.status, dev.reason = "free", None
            self.emit_device(dev, idle_confirmed=confirmed)

    def renew(self, lease: Lease) -> None:
        lease.expires_at = min(time.time() + lease.ttl_s, lease.max_hold_until or 0)
        if time.time() - lease.last_renew_event > 5.0:
            lease.last_renew_event = time.time()
            self.emit("lease", device=lease.device, lease_id=lease.lease_id, holder=lease.holder,
                      event="renewed", expires_at=lease.expires_at)

    async def acquire(self, who: str, dev_id: str, ttl_s: float, wait_s: float) -> tuple[Lease, bool]:
        dev = self.devices.get(dev_id)
        if dev is None:
            raise RigAPIError(404, "unknown", f"no device {dev_id}", "GET /v1/devices")
        if self.maintenance:
            raise RigAPIError(409, "maintenance", "rig is in maintenance", "retry later")
        if dev.status == "offline":
            raise RigAPIError(409, "device_offline", f"{dev.id} is offline: {dev.reason or 'unknown'}", "GET /v1/devices")
        active = sum(1 for le in self.leases.values() if le.holder == who and le.state == "active")
        if active >= MAX_ACTIVE_PER_NODE:
            raise RigAPIError(409, "busy", f"node already holds {active} leases", "POST /v1/leases/{id}/release")
        lease = Lease(lease_id=f"l-{secrets.token_hex(6)}", device=dev.id, holder=who, ttl_s=ttl_s)
        self.leases[lease.lease_id] = lease
        if dev.status == "free" and not dev.queue:
            self._grant(dev, lease)
        else:
            dev.queue.append(lease)
            self.emit("lease", device=dev.id, lease_id=lease.lease_id, holder=who, event="queued",
                      position=len(dev.queue))
            self.emit_device(dev)
            try:
                await asyncio.wait_for(lease.granted.wait(), timeout=wait_s * self.speed)
            except asyncio.TimeoutError:
                pass
        return lease, lease.state == "active"

    # ---- runs -----------------------------------------------------------------------------
    def log(self, run: Run, text: str) -> None:
        line = {"ts": time.time(), "text": text}
        run.logs.append(line)
        if len(run.logs) > LOG_KEEP:
            del run.logs[: len(run.logs) - LOG_KEEP]
        now = time.monotonic()
        run.log_budget = min(float(LOG_RATE_PER_S), run.log_budget + (now - run.log_stamp) * LOG_RATE_PER_S)
        run.log_stamp = now
        if run.log_budget >= 1.0:  # events are rate-capped; the stored log is complete
            run.log_budget -= 1.0
            self.emit("log", device=run.device, run_id=run.run_id, ts=line["ts"], text=text)

    def set_run(self, run: Run, state: str) -> None:
        if run.state in ("stopped", "failed"):
            return
        run.state = state
        self.emit("run", device=run.device, run_id=run.run_id, state=state)

    def start_run(self, lease: Lease, repo_url: str, sha: str, path: str) -> Run:
        for old in self.runs.values():
            if old.lease_id == lease.lease_id and old.state not in ("failed", "stopped"):
                old.state = "stopped"
                if old.task:
                    old.task.cancel()
                self.emit("run", device=old.device, run_id=old.run_id, state="stopped")
        run = Run(run_id=f"r-{secrets.token_hex(6)}", device=lease.device, lease_id=lease.lease_id,
                  repo_url=repo_url, sha=sha, path=path)
        self.runs[run.run_id] = run
        self.emit("run", device=run.device, run_id=run.run_id, state="queued")
        run.task = self.spawn(self._execute(run, lease))
        return run

    async def _execute(self, run: Run, lease: Lease) -> None:
        dev = self.devices[run.device]
        start = time.time()
        work: Path | None = None
        try:
            self.set_run(run, "fetching")
            src: Path | None = None
            if dev.driver.mock:
                await self.sleep(0.3)
                self.log(run, f"[mock] fetching {run.sha[:12]} {run.path}")
            else:
                work = make_workdir()
                src = await fetch_source(run.repo_url, run.sha, run.path, work)
            self.set_run(run, "building")
            ctx = RunCtx(run.run_id, lease.lease_id, run.repo_url, run.sha, run.path, src,
                         lambda text, r=run: self.log(r, text))
            await dev.driver.deploy(ctx)
            run.build_time_s = round(time.time() - start, 2)
            self.set_run(run, "running")
            if dev.driver.mock:
                self.log(run, "READY")
        except asyncio.CancelledError:
            raise
        except DeployError as e:
            run.error = {"code": e.code, "message": e.message, "log_tail": e.log_tail}
            self.set_run(run, "failed")
        except Exception as e:  # noqa: BLE001
            run.error = {"code": "build_failed", "message": f"{type(e).__name__}: {e}", "log_tail": ""}
            self.set_run(run, "failed")
        finally:
            if work:
                shutil.rmtree(work, ignore_errors=True)

    # ---- verify + evidence ----------------------------------------------------------------
    async def run_verify(self, v: Verify, assertions: list[dict[str, Any]], duration_s: float) -> None:
        started = time.time()
        lease = self.leases[v.lease_id]
        dev = self.devices[v.device]
        try:
            runs = [r for r in self.runs.values() if r.lease_id == v.lease_id]
            run = runs[-1] if runs else None
            running = run is not None and run.state == "running"
            logs, rest = split_assertions(assertions)
            results: list[dict[str, Any] | None] = [None] * len(assertions)
            for i, a in logs:
                pat = str(a.get("pattern", ""))
                hit = next(((n, ln["text"]) for n, ln in enumerate(run.logs, 1) if pat and pat in ln["text"]), None) if run else None
                results[i] = {"type": "log_contains", "target": a.get("target"),
                              "expected": {k: x for k, x in a.items() if k not in ("type", "target")},
                              "passed": hit is not None, "self_reported": True,
                              "measured": {"line": hit[1], "line_no": hit[0]} if hit else {"matched": False},
                              "uncertainty": {},
                              "detail": "pattern found in run logs (self-reported)" if hit else "pattern not in run logs"}
            evidence_src: str | None = None
            if rest:
                if not running:
                    for i, a in rest:
                        results[i] = unavailable_result(a, "")
                        results[i]["detail"] = "no program running on the device"
                else:
                    obs = await self.verifier.observe(
                        v.device, [a for _, a in rest], duration_s, run.run_id if run else "",
                        run.state if run else None, run.sha if run else "", self.speed)
                    for (i, _), res in zip(rest, obs["results"]):
                        results[i] = res
                    evidence_src = obs.get("evidence_dir")
            v.results = [r for r in results if r is not None]
            v.evidence_id = secrets.token_hex(16)
            self._write_evidence(v, lease, run, evidence_src, started)
            v.state = "done"
            measured = [r for r in v.results if not r.get("self_reported")]
            passed = bool(measured) and all(r.get("passed") for r in measured)
            dev.last_verdict = {"verify_id": v.verify_id, "passed": passed, "at": time.time()}
            self.emit("verify", device=v.device, verify_id=v.verify_id, state="done", results=v.results)
            self.emit("evidence", device=v.device, evidence_id=v.evidence_id, passed=passed)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            v.state, v.error = "error", f"{type(e).__name__}: {e}"
            self.emit("verify", device=v.device, verify_id=v.verify_id, state="error")
        finally:
            v.done.set()

    def _write_evidence(self, v: Verify, lease: Lease, run: Run | None, src: str | None, started: float) -> None:
        assert v.evidence_id
        out = self.evidence_dir / v.evidence_id
        out.mkdir(parents=True)
        files: list[str] = []
        if src and Path(src).is_dir():
            for p in sorted(Path(src).iterdir()):
                if p.is_file() and p.name != "evidence.json":
                    shutil.copyfile(p, out / p.name)
                    files.append(p.name)
        elif self.mock:
            from .mock_assets import CLIP_GIF, FRAME_JPEG
            (out / "frame-0.jpg").write_bytes(FRAME_JPEG)
            (out / "clip.gif").write_bytes(CLIP_GIF)
            files = ["clip.gif", "frame-0.jpg"]
        h = self.health()
        meta = {"evidence_id": v.evidence_id, "rig_id": self.rig_id, "device": v.device, "holder": lease.holder,
                "farm_id": lease.holder.removeprefix("devin-"), "repo_url": run.repo_url if run else "",
                "sha": run.sha if run else "", "run_id": run.run_id if run else None, "verify_id": v.verify_id,
                "started_at": started, "finished_at": time.time(), "results": v.results,
                "rig": {"temp_c": h["temp_c"], "throttled": h["throttled"]},
                "verifier_version": "mock-0" if self.mock else getattr(self.verifier, "name", "http"),
                "files": files, "sample": self.mock}
        if self.mock:
            meta["mock"] = True
        (out / "evidence.json").write_text(json.dumps(meta))

    def evidence_file(self, evidence_id: str, name: str) -> Path | None:
        if not evidence_id.isalnum() or name != Path(name).name or name.startswith("."):
            return None
        p = self.evidence_dir / evidence_id / name
        return p if p.is_file() else None

    async def snapshot(self, dev_id: str) -> bytes | None:
        if self.mock:
            from .mock_assets import FRAME_JPEG
            return FRAME_JPEG
        return await self.verifier.snapshot(dev_id)

    def snapshot_allowed(self, dev_id: str) -> bool:
        now = time.monotonic()
        if now - self._snap_at.get(dev_id, 0.0) < 1.0:
            return False
        self._snap_at[dev_id] = now
        return True
