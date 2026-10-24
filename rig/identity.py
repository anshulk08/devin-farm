"""Caller identity (C1): tailscale whois in production, X-Mock-Node with --mock-identity.

Roles: `session` (tag:devin-session) may use the C1 session API; `control` (tag:control) and `team`
(user-owned tailnet nodes, optionally restricted to cfg.team_logins; tag:rig = the rig itself) may also
use the C3 control/admin API. Anything else is not_on_tailnet (403)."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass

CACHE_S = 30.0


class IdentityError(Exception):
    pass


@dataclass(frozen=True)
class Caller:
    node: str
    role: str  # session | control | team

    @property
    def is_operator(self) -> bool:
        return self.role in ("control", "team")


class MockIdentity:
    """`X-Mock-Node: <name>`; names starting with `devin-` are sessions, any other is team."""

    async def resolve(self, ip: str, headers: dict[str, str]) -> Caller:
        node = headers.get("x-mock-node", "")
        if not node:
            raise IdentityError("caller has no tailnet identity (X-Mock-Node)")
        return Caller(node, "session" if node.startswith("devin-") else "team")

    async def online_nodes(self) -> set[str] | None:
        return None  # holder-offline detection is disabled for mock identity


class TailscaleIdentity:
    def __init__(self, team_logins: list[str] | None = None, binary: str = "tailscale"):
        self.team_logins = set(team_logins or [])
        self.bin = binary
        self._cache: dict[str, tuple[float, Caller | None]] = {}

    async def _run(self, *args: str) -> dict:
        proc = await asyncio.create_subprocess_exec(
            self.bin, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode != 0:
            raise IdentityError(err.decode("utf-8", "replace").strip() or "tailscale failed")
        return json.loads(out)

    async def resolve(self, ip: str, headers: dict[str, str]) -> Caller:
        hit = self._cache.get(ip)
        if hit and time.time() - hit[0] < CACHE_S:
            if hit[1] is None:
                raise IdentityError("caller is not an allowed tailnet node")
            return hit[1]
        try:
            who = await self._run("whois", "--json", ip)
        except (IdentityError, OSError, asyncio.TimeoutError, json.JSONDecodeError) as e:
            raise IdentityError(f"whois failed for {ip}: {e}") from e
        node = who.get("Node") or {}
        name = (node.get("ComputedName") or node.get("Name") or "").rstrip(".").split(".")[0]
        tags = node.get("Tags") or []
        caller: Caller | None = None
        if "tag:devin-session" in tags:
            caller = Caller(name, "session")
        elif "tag:control" in tags:
            caller = Caller(name, "control")
        elif "tag:rig" in tags:
            caller = Caller(name, "team")
        elif not tags:
            login = (who.get("UserProfile") or {}).get("LoginName", "")
            if not self.team_logins or login in self.team_logins:
                caller = Caller(name, "team")
        self._cache[ip] = (time.time(), caller)
        if caller is None or not name:
            raise IdentityError("caller is not an allowed tailnet node")
        return caller

    async def online_nodes(self) -> set[str] | None:
        """Hostnames currently online per `tailscale status --json`; None if unknown."""
        try:
            st = await self._run("status", "--json")
        except (IdentityError, OSError, asyncio.TimeoutError, json.JSONDecodeError):
            return None
        names = set()
        for peer in (st.get("Peer") or {}).values():
            if peer.get("Online"):
                dns = (peer.get("DNSName") or "").rstrip(".").split(".")[0]
                names.update({peer.get("HostName", ""), dns})
        return names
