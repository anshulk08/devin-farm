"""Simulated boards: no hardware, timings mimic the real flow (fetch -> build -> run, reset ~1.5 s)."""
from __future__ import annotations

import asyncio

from .base import Driver, RunCtx

OUTPUTS = {"pico": ["pico.led", "pico.leds"], "unoq": ["unoq.matrix", "unoq.rgb1"]}


class MockDriver(Driver):
    mock = True

    def __init__(self, dev_id: str, cfg: dict, speed: float = 1.0):
        super().__init__(dev_id, cfg)
        self.type = cfg["type"]
        self.outputs = list(OUTPUTS.get(self.type, []))
        self.speed = speed
        self.present = True  # tests may flip this to simulate an unplugged board

    async def _sleep(self, s: float) -> None:
        await asyncio.sleep(s * self.speed)

    async def discover(self) -> tuple[bool, str]:
        return (True, "") if self.present else (False, "not_present: simulated unplug")

    async def deploy(self, ctx: RunCtx) -> None:
        ctx.log(f"[mock] building {ctx.sha[:12]} {ctx.path}")
        await self._sleep(0.8)

    async def stop(self) -> None:
        return None

    async def reset_to_idle(self) -> None:
        await self._sleep(1.5)

    def describe_md(self) -> str:
        return (f"# {self.id} ({self.type}, mock)\n\nOutputs: {', '.join(self.outputs)}\n\n"
                "Mock verifier: SHAs starting with `bad` misbehave physically; logs still print READY.\n")
