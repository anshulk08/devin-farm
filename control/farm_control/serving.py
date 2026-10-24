"""Run several ASGI apps in one event loop (operator, public, and mock services)."""
from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import uvicorn


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:  # the CLI owns SIGINT/SIGTERM for all servers
        yield


def bind(host: str = "127.0.0.1", port: int = 0) -> socket.socket:
    sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    return sock


@dataclass
class Served:
    server: _Server
    task: asyncio.Task[Any]
    url: str

    async def stop(self) -> None:
        self.server.should_exit = True
        try:
            await asyncio.wait_for(self.task, timeout=5)
        except (asyncio.TimeoutError, asyncio.CancelledError, SystemExit):
            self.task.cancel()


async def serve(app: Any, sock: socket.socket, log_level: str = "warning") -> Served:
    config = uvicorn.Config(app, log_level=log_level, lifespan="off", timeout_graceful_shutdown=1,
                            access_log=log_level in ("debug", "info"))
    server = _Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        if task.done():
            task.result()  # re-raise the startup failure
            raise RuntimeError("server exited during startup")
        await asyncio.sleep(0.01)
    host, port = sock.getsockname()[:2]
    return Served(server, task, f"http://{host}:{port}")
