"""Raspberry Pi Pico (MicroPython) via mpremote. Deploy = copy program files + hard reset; reset to idle
= wipe the filesystem (including boot.py) and install rig/idle/pico/main.py. Serial tail via pyserial."""
from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path

from .base import DeployError, Driver, RunCtx, run_cmd

IDLE_MAIN = Path(__file__).resolve().parent.parent / "idle" / "pico" / "main.py"
MPREMOTE = os.environ.get("FARM_MPREMOTE") or str(Path.home() / ".local/bin/mpremote")

WIPE = (
    "import os\n"
    "def rm(p):\n"
    "    for n in os.listdir(p):\n"
    "        f = p.rstrip('/') + '/' + n\n"
    "        if os.stat(f)[0] & 0x4000:\n"
    "            rm(f); os.rmdir(f)\n"
    "        else:\n"
    "            os.remove(f)\n"
    "rm('/')\n"
)

DESCRIBE = """# {id} (Raspberry Pi Pico, MicroPython)

**Entry:** `main.py` in your ticket directory; it is copied to the board's filesystem as `/main.py` and runs after
a hard reset. Extra `.py` files next to it are copied too. Print `READY` when your program has started.

**Outputs:** `pico.led` (the onboard LED, GP25) and `pico.leds`, an indexed bank:
index 0 = onboard LED (GP25), 1..4 = external LEDs on GP16, GP17, GP18, GP19 (each with a series resistor).

**Gotchas**
- Use `machine.Pin(n, machine.Pin.OUT)`; `Pin("LED")` is not used on this board, drive GP25 directly.
- Timing: use `time.sleep_ms` / `time.ticks_ms`; the camera measures real LED timing, `print` output proves nothing.
- Do not touch `boot.py`; the rig wipes the filesystem between leases and re-installs an idle blinker.
- No network, no `machine.bootloader()`, no USB reconfiguration.

**Assertions you can expect:** `led_blink`, `led_sequence` (target `pico.leds`), `led_state`, `log_contains` (self-reported only).
"""


class PicoDriver(Driver):
    outputs = ["pico.led", "pico.leds"]

    def __init__(self, dev_id: str, cfg: dict):
        super().__init__(dev_id, cfg)
        self._tail_stop: threading.Event | None = None
        self._tail_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def discover(self) -> tuple[bool, str]:
        if not self.path or not os.path.exists(self.path):
            return False, f"not_present: {self.path} missing"
        return True, ""

    def _mp(self, *args: str) -> list[str]:
        return [MPREMOTE, "connect", self.path or "", *args]

    async def _wait_present(self, timeout: float = 10.0) -> bool:
        end = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < end:
            if (await self.discover())[0]:
                return True
            await asyncio.sleep(0.3)
        return False

    async def _stop_tail(self) -> None:
        if self._tail_stop:
            self._tail_stop.set()
        if self._tail_task:
            await asyncio.gather(self._tail_task, return_exceptions=True)
        self._tail_stop = self._tail_task = None

    async def _start_tail(self, ctx: RunCtx) -> None:
        stop = threading.Event()
        self._tail_stop = stop
        loop = asyncio.get_running_loop()

        def pump() -> None:
            import serial  # pyserial
            buf = b""
            while not stop.is_set():
                try:
                    with serial.Serial(self.path, 115200, timeout=0.3) as port:
                        while not stop.is_set():
                            chunk = port.read(256)
                            if not chunk:
                                continue
                            buf += chunk
                            while b"\n" in buf:
                                line, buf = buf.split(b"\n", 1)
                                loop.call_soon_threadsafe(ctx.log, line.decode("utf-8", "replace").rstrip("\r"))
                except (OSError, serial.SerialException):
                    stop.wait(0.5)  # board resetting or unplugged; retry until stopped

        self._tail_task = asyncio.create_task(asyncio.to_thread(pump))

    async def deploy(self, ctx: RunCtx) -> None:
        assert ctx.src_dir is not None
        src = ctx.src_dir
        main = src / "main.py"
        if not main.is_file():
            raise DeployError("lint_failed", "pico programs need a main.py at the ticket path root")
        async with self._lock:
            await self._stop_tail()
            rc, out = await run_cmd(self._mp("exec", WIPE), 30)
            if rc != 0:
                raise DeployError("build_failed", "could not clear the board filesystem", out[-2000:])
            files = sorted(p for p in src.rglob("*") if p.is_file())
            for p in files:
                rel = p.relative_to(src)
                for d in list(rel.parents)[::-1]:
                    if str(d) not in (".", ""):
                        await run_cmd(self._mp("fs", "mkdir", f":{d}"), 15)
                rc, out = await run_cmd(self._mp("fs", "cp", str(p), f":{rel}"), 30)
                if rc != 0:
                    raise DeployError("build_failed", f"mpremote copy of {rel} failed", out[-2000:])
            await run_cmd(self._mp("reset"), 15)
            if not await self._wait_present():
                raise DeployError("build_failed", "board did not come back after reset")
            await asyncio.sleep(0.5)
            await self._start_tail(ctx)

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_tail()

    async def reset_to_idle(self) -> None:
        async with self._lock:
            await self._stop_tail()
            ok, why = await self.discover()
            if not ok:
                raise RuntimeError(why)
            rc, out = await run_cmd(self._mp("exec", WIPE), 30)
            if rc != 0:
                raise RuntimeError(f"wipe failed: {out[-500:]}")
            rc, out = await run_cmd(self._mp("fs", "cp", str(IDLE_MAIN), ":main.py"), 30)
            if rc != 0:
                raise RuntimeError(f"idle install failed: {out[-500:]}")
            await run_cmd(self._mp("reset"), 15)
            if not await self._wait_present():
                raise RuntimeError("board did not come back after idle reset")

    def describe_md(self) -> str:
        return DESCRIBE.format(id=self.id)
