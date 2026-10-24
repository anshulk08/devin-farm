"""Mock mode: two mock rigs (rig-2 proves multi-rig discovery, F9), a mock Devin API and a mock
Tailscale API, all on 127.0.0.1 ephemeral ports. Everything control shows in this mode is badged MOCK."""
from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..serving import Served, bind, serve
from .cloud import MockPeerSource, MockWorld, create_cloud_app
from .rig import MockRig, create_rig_app

MOCK_TICKETS = Path(__file__).resolve().parent / "tickets"
DEFAULT_RIGS: list[tuple[str, list[tuple[str, str]]]] = [
    ("rig-1", [("pico-1", "pico"), ("unoq-1", "unoq")]),
    ("rig-2", [("pico-2", "pico")]),
]


@dataclass
class MockStack:
    world: MockWorld
    cloud: Served
    rigs: list[MockRig] = field(default_factory=list)
    rig_servers: list[Served] = field(default_factory=list)

    @property
    def peers(self) -> MockPeerSource:
        return MockPeerSource(self.world)

    async def stop(self) -> None:
        for s in self.world.sessions.values():
            if s.task:
                s.task.cancel()
        for rig in self.rigs:
            await rig.stop()
        for srv in [*self.rig_servers, self.cloud]:
            await srv.stop()


async def start_mock_stack(speed: float = 1.0, health_interval_s: float = 5.0,
                           rigs: list[tuple[str, list[tuple[str, str]]]] | None = None) -> MockStack:
    world = MockWorld(speed)
    stack = MockStack(world, await serve(create_cloud_app(world), bind()))
    for rig_id, devices in rigs or DEFAULT_RIGS:
        rig = MockRig(rig_id, devices, speed=speed, health_interval_s=health_interval_s)
        rig.start()
        srv = await serve(create_rig_app(rig), bind())
        stack.rigs.append(rig)
        stack.rig_servers.append(srv)
        world.add_rig(rig_id, srv.url)
    return stack


def mock_settings(base: Settings, stack: MockStack) -> Settings:
    return dataclasses.replace(
        base, mode="mock", operator_auth="open",
        devin_api_base=stack.cloud.url, devin_api_key="mock-devin-key", devin_org_id="org-mock",
        ts_api_base=stack.cloud.url, ts_client_id="mock-client", ts_client_secret="mock-secret",
        mock_identity="farm-control",
        tickets_dir=base.tickets_dir if os.environ.get("FARM_TICKETS_DIR") else MOCK_TICKETS,
        var_dir=base.var_dir / "mock", discovery_interval_s=2.0, devin_poll_interval_s=2.0)
