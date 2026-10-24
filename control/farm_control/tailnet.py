"""Tailnet facts: peer discovery (`tailscale status --json`) and the Tailscale API
(OAuth client: mint one-off session join keys, delete session nodes). CONTRACTS C0, C10."""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

_FARM_NODE = re.compile(r"^devin-(s-[0-9a-f]{8})(?:-\d+)?$")


def farm_id_from_node(node_name: str) -> str | None:
    """`devin-s-1a2b3c4d` (or a MagicDNS-deduplicated `devin-s-1a2b3c4d-1`) -> `s-1a2b3c4d`."""
    m = _FARM_NODE.match(node_name or "")
    return m.group(1) if m else None


class TailnetError(RuntimeError):
    pass


@dataclass
class Peer:
    hostname: str
    ips: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    online: bool = False
    node_id: str = ""
    url: str | None = None  # explicit control-API base URL (mock rigs); otherwise derived from ips

    def ipv4(self) -> str | None:
        return next((ip for ip in self.ips if ":" not in ip), None)


class PeerSource(Protocol):
    async def peers(self) -> list[Peer]: ...


def parse_status(doc: dict[str, Any]) -> list[Peer]:
    peers = []
    for p in (doc.get("Peer") or {}).values():
        dns = (p.get("DNSName") or "").split(".")[0]
        peers.append(Peer(
            hostname=dns or p.get("HostName", ""),
            ips=list(p.get("TailscaleIPs") or []),
            tags=list(p.get("Tags") or []),
            online=bool(p.get("Online")),
            node_id=p.get("ID", ""),
        ))
    return peers


class CliPeerSource:
    def __init__(self, binary: str = "tailscale"):
        self.binary = binary

    async def peers(self) -> list[Peer]:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary, "status", "--json",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError as exc:
            raise TailnetError(f"{self.binary} not found") from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=10)
        except asyncio.TimeoutError as exc:
            proc.kill()
            raise TailnetError("tailscale status timed out") from exc
        if proc.returncode != 0:
            raise TailnetError(err.decode(errors="replace").strip() or f"exit {proc.returncode}")
        return parse_status(json.loads(out))


class TailscaleAPIError(RuntimeError):
    pass


class TailscaleAPI:
    """Minimal Tailscale API v2 client authenticated by an OAuth client (scopes auth_keys, devices:core)."""

    def __init__(self, base: str, client_id: str, client_secret: str, http: httpx.AsyncClient, tailnet: str = "-"):
        self.base = base.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self.tailnet = tailnet
        self._token = ""
        self._token_exp = 0.0
        self._lock = asyncio.Lock()

    async def _auth(self) -> dict[str, str]:
        async with self._lock:
            if not self._token or time.monotonic() > self._token_exp - 60:
                r = await self._http.post(f"{self.base}/api/v2/oauth/token", data={
                    "client_id": self._client_id, "client_secret": self._client_secret,
                    "grant_type": "client_credentials"})
                self._check(r, "oauth token")
                body = r.json()
                self._token = body["access_token"]
                self._token_exp = time.monotonic() + float(body.get("expires_in", 3600))
        return {"Authorization": f"Bearer {self._token}"}

    @staticmethod
    def _check(r: httpx.Response, what: str) -> None:
        if r.status_code >= 400:
            try:
                msg = r.json().get("message") or r.text
            except ValueError:
                msg = r.text
            raise TailscaleAPIError(f"{what}: HTTP {r.status_code}: {msg[:200]}")

    async def mint_session_key(self, farm_id: str, tag: str, expiry_s: int = 3600) -> tuple[str, str]:
        """One-off, ephemeral, pre-authorized, tagged join key (C0). Returns (key_id, key)."""
        body = {
            "capabilities": {"devices": {"create": {
                "reusable": False, "ephemeral": True, "preauthorized": True, "tags": [tag]}}},
            "expirySeconds": expiry_s,
            "description": f"farm session {farm_id}",
        }
        r = await self._http.post(f"{self.base}/api/v2/tailnet/{self.tailnet}/keys", json=body,
                                  headers=await self._auth())
        self._check(r, "create auth key")
        data = r.json()
        return data.get("id", ""), data["key"]

    async def delete_key(self, key_id: str) -> None:
        r = await self._http.delete(f"{self.base}/api/v2/tailnet/{self.tailnet}/keys/{key_id}",
                                    headers=await self._auth())
        if r.status_code != 404:
            self._check(r, "delete auth key")

    async def devices(self) -> list[dict[str, Any]]:
        r = await self._http.get(f"{self.base}/api/v2/tailnet/{self.tailnet}/devices", headers=await self._auth())
        self._check(r, "list devices")
        return r.json().get("devices", [])

    async def delete_nodes(self, hostname: str) -> int:
        """Delete every device whose MagicDNS name or hostname is `hostname`. Returns the count."""
        target = farm_id_from_node(hostname)
        deleted = 0
        for dev in await self.devices():
            names = {dev.get("hostname", ""), (dev.get("name") or "").split(".")[0]}
            if hostname in names or (target and any(farm_id_from_node(n) == target for n in names)):
                node_id = dev.get("nodeId") or dev.get("id")
                r = await self._http.delete(f"{self.base}/api/v2/device/{node_id}", headers=await self._auth())
                if r.status_code != 404:
                    self._check(r, "delete device")
                deleted += 1
        return deleted
