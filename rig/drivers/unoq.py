"""Arduino Uno Q via adb + arduino-app-cli (commands proven on the verifier lane's board).
Deploy = preflight lint, stop apps, push the ticket dir to ~/ArduinoApps/<name>, `app start`, tail `app logs`.
Reset = stop everything, wipe non-idle apps, push + start the idle app (rig/idle/unoq)."""
from __future__ import annotations

import asyncio
import os
import re
import shlex
import shutil
import tempfile
from pathlib import Path

from .base import DeployError, Driver, RunCtx, run_cmd

IDLE_APP = Path(__file__).resolve().parent.parent / "idle" / "unoq"
APPS_DIR = "/home/arduino/ArduinoApps"
IDLE_NAME = "farm-idle"
ADB = os.environ.get("FARM_ADB", "adb")
BUILD_TIMEOUT = 420.0

DESCRIBE = """# {id} (Arduino Uno Q)

**Layout (exact):** `app.yaml`, `python/main.py`, `python/requirements.txt` (may be empty), `sketch/sketch.ino`,
`sketch/sketch.yaml`. `python/main.py` must call `App.run(...)` or the app exits immediately.

**Outputs:** `unoq.matrix` is the built-in 8 rows x 13 columns LED matrix; `unoq.rgb1` is the RGB LED.

**Gotchas**
- The board has **no internet**: `sketch.yaml` libraries must come from the allowlist ({libs}); `requirements.txt`
  may only list wheels already installed on the board.
- Timing-critical output (scrolling at an exact column rate) belongs in the sketch on the MCU. A Linux-side Python loop
  can print the right log lines and still stutter on camera.
- The first build takes about a minute or two; the rig reports `building` until the app is up.
- `Bridge.call` inside a Bridge callback deadlocks; keep callbacks short.
- Matrix frames: 8x13 cells, `Arduino_LED_Matrix::draw()` takes 104 bytes row-major (0/1 with `setGrayscaleBits(1)`).

**Assertions you can expect:** `matrix_frame`, `matrix_text`, `rgb_color`, `log_contains` (self-reported only).
"""


def lint_app(root: Path, allowlist: list[str]) -> list[str]:
    """Preflight (catches failures that would burn a multi-minute build). Returns error strings."""
    errs: list[str] = []
    for rel in ("app.yaml", "python/main.py", "sketch/sketch.ino", "sketch/sketch.yaml"):
        if not (root / rel).is_file():
            errs.append(f"missing {rel} (layout must be app.yaml, python/main.py, sketch/sketch.ino, sketch/sketch.yaml)")
    if errs:
        return errs
    if "App.run(" not in (root / "python/main.py").read_text("utf-8", "replace"):
        errs.append("python/main.py never calls App.run(...); the app would exit immediately")
    yaml_text = (root / "sketch/sketch.yaml").read_text("utf-8", "replace")
    for lib in re.findall(r"^\s*-\s*([A-Za-z0-9_ .-]+?)(?:\s*\(.*\))?\s*$", yaml_text, re.M):
        if lib.startswith("platform:"):
            continue
        if lib not in allowlist:
            errs.append(f"sketch.yaml library {lib!r} is not on the rig allowlist: {', '.join(allowlist)}")
    req = root / "python/requirements.txt"
    if req.is_file() and any(ln.strip() and not ln.lstrip().startswith("#") for ln in req.read_text().splitlines()):
        errs.append("python/requirements.txt lists packages, but the board has no internet; remove them")
    return errs


class UnoQDriver(Driver):
    outputs = ["unoq.matrix", "unoq.rgb1"]

    def __init__(self, dev_id: str, cfg: dict, allowlist: list[str] | None = None):
        super().__init__(dev_id, cfg)
        self.serial: str | None = cfg.get("adb_serial")
        self.allowlist = allowlist or []
        self._lock = asyncio.Lock()
        self._tail: asyncio.subprocess.Process | None = None
        self._tail_task: asyncio.Task | None = None
        self._current: str | None = None

    def _adb(self, *args: str) -> list[str]:
        return [ADB] + (["-s", self.serial] if self.serial else []) + list(args)

    async def discover(self) -> tuple[bool, str]:
        if self.path and not os.path.exists(self.path):
            return False, f"not_present: {self.path} missing"
        rc, out = await run_cmd(self._adb("get-state"), 8)
        if rc != 0 or "device" not in out:
            return False, f"not_present: adb reports no device ({out[-120:]})"
        return True, ""

    async def _sh(self, cmd: str, timeout: float = 60) -> tuple[int, str]:
        return await run_cmd(self._adb("shell", cmd), timeout)

    async def _stop_tail(self) -> None:
        if self._tail and self._tail.returncode is None:
            self._tail.kill()
        if self._tail_task:
            await asyncio.gather(self._tail_task, return_exceptions=True)
        self._tail = self._tail_task = None

    async def _stop_apps(self) -> None:
        await self._stop_tail()
        if self._current:
            await self._sh(f"arduino-app-cli app stop {shlex.quote(self._current)}", 120)
        # stop every app (JSON list from the CLI); ignore failures, apps may already be stopped
        rc, out = await self._sh("ls -1 " + APPS_DIR, 15)
        for name in out.split() if rc == 0 else []:
            await self._sh(f"arduino-app-cli app stop {APPS_DIR}/{shlex.quote(name)}", 120)
        self._current = None

    async def _push_start(self, src: Path, name: str, timeout: float) -> tuple[int, str]:
        remote = f"{APPS_DIR}/{name}"
        rc, out = await self._sh(f"rm -rf {remote} && mkdir -p {remote}", 30)
        if rc != 0:
            return rc, out
        rc, out = await run_cmd(self._adb("push", f"{src}/.", remote), 90)
        if rc != 0:
            return rc, out
        self._current = remote
        return await self._sh(f"arduino-app-cli app start {remote}", timeout)

    async def deploy(self, ctx: RunCtx) -> None:
        assert ctx.src_dir is not None
        errs = lint_app(ctx.src_dir, self.allowlist)
        if errs:
            raise DeployError("lint_failed", "; ".join(errs))
        name = "lease-" + re.sub(r"[^a-z0-9]", "", ctx.lease_id.lower())[:16]
        async with self._lock:
            await self._stop_apps()
            await self._sh(f"find {APPS_DIR} -mindepth 1 -maxdepth 1 -name 'lease-*' -exec rm -rf {{}} +", 30)
            rc, out = await self._push_start(ctx.src_dir, name, BUILD_TIMEOUT)
            if rc != 0:
                self._current = None
                raise DeployError("build_failed", "arduino-app-cli app start failed", out[-3000:])
            ctx.log(out[-500:] if out else "app started")
            await self._start_tail(ctx, f"{APPS_DIR}/{name}")

    async def _start_tail(self, ctx: RunCtx, remote: str) -> None:
        proc = await asyncio.create_subprocess_exec(
            *self._adb("shell", f"arduino-app-cli app logs {remote} --follow"),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        self._tail = proc

        async def pump() -> None:
            assert proc.stdout
            async for line in proc.stdout:
                ctx.log(line.decode("utf-8", "replace").rstrip())

        self._tail_task = asyncio.create_task(pump())

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_tail()
            if self._current:
                await self._sh(f"arduino-app-cli app stop {shlex.quote(self._current)}", 120)

    async def reset_to_idle(self) -> None:
        async with self._lock:
            ok, why = await self.discover()
            if not ok:
                raise RuntimeError(why)
            await self._stop_apps()
            await self._sh(f"find {APPS_DIR} -mindepth 1 -maxdepth 1 ! -name {IDLE_NAME} -name 'lease-*' -exec rm -rf {{}} +", 30)
            rc, out = await self._push_start(IDLE_APP, IDLE_NAME, BUILD_TIMEOUT)
            if rc != 0:
                raise RuntimeError(f"idle app start failed: {out[-500:]}")
            await self._sh(f"arduino-app-cli properties set default {APPS_DIR}/{IDLE_NAME}", 30)
            self._current = f"{APPS_DIR}/{IDLE_NAME}"

    def describe_md(self) -> str:
        return DESCRIBE.format(id=self.id, libs=", ".join(self.allowlist) or "none")
