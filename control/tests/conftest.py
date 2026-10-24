from __future__ import annotations

import asyncio
import dataclasses
import time
from collections.abc import AsyncIterator, Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from farm_control.app import Control, create_operator_app, create_public_app
from farm_control.config import Settings
from farm_control.mock import mock_settings, start_mock_stack


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def eventually(cond: Callable[[], Any], timeout: float = 10.0, interval: float = 0.05) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = cond()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)


@pytest.fixture
async def farm(tmp_path, anyio_backend) -> AsyncIterator[SimpleNamespace]:
    """Control wired to the mock stack (mock rigs, mock Devin, mock Tailscale API) at 20x speed."""
    stack = await start_mock_stack(speed=0.05, health_interval_s=0.2)
    settings = dataclasses.replace(mock_settings(Settings(var_dir=tmp_path), stack),
                                   discovery_interval_s=0.2, devin_poll_interval_s=0.2)
    ctl = Control(settings, stack.peers)
    await ctl.start()
    op = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_operator_app(ctl)), base_url="http://op")
    pub = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_public_app(ctl)), base_url="http://pub")
    await eventually(lambda: all(c.online for c in ctl.registry.all()) and len(ctl.registry.all()) == 2)
    yield SimpleNamespace(stack=stack, world=stack.world, ctl=ctl, op=op, pub=pub, settings=settings)
    await op.aclose()
    await pub.aclose()
    await ctl.stop()
    await stack.stop()
