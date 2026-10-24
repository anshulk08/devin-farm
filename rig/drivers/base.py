"""Driver interface (WORKSPLIT lane A item 4) and subprocess helper."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class DeployError(Exception):
    """Raised by Driver.deploy; code is a C1 run error code (lint_failed, build_failed, ...)."""

    def __init__(self, code: str, message: str, log_tail: str = ""):
        super().__init__(message)
        self.code, self.message, self.log_tail = code, message, log_tail


@dataclass
class RunCtx:
    run_id: str
    lease_id: str
    repo_url: str
    sha: str
    path: str
    src_dir: Path | None          # validated checkout of `path`; None for mock drivers
    log: Callable[[str], None]    # sink for board output (rate capped by the engine)


async def run_cmd(args: list[str], timeout: float, stdin: bytes | None = None) -> tuple[int, str]:
    """Run a command without a shell; kill it on timeout. Returns (returncode, stdout+stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    except FileNotFoundError:
        return 127, f"{args[0]}: command not found"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"{' '.join(args[:4])} timed out after {timeout:.0f}s"
    return proc.returncode or 0, out.decode("utf-8", "replace").strip()


class Driver:
    """One physical (or simulated) board. All methods are coroutines except describe_md."""

    mock = False
    outputs: list[str] = []

    def __init__(self, dev_id: str, cfg: dict):
        self.id, self.cfg = dev_id, cfg
        self.path: str | None = cfg.get("path")

    async def discover(self) -> tuple[bool, str]:
        """(present, reason). Offline reason is shown on the map."""
        raise NotImplementedError

    async def deploy(self, ctx: RunCtx) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        """Stop the running program (and any log tail)."""
        raise NotImplementedError

    async def reset_to_idle(self) -> None:
        """Wipe user code and start the C8 idle program."""
        raise NotImplementedError

    async def health(self) -> dict:
        present, reason = await self.discover()
        return {"present": present, "reason": reason}

    def describe_md(self) -> str:
        raise NotImplementedError
