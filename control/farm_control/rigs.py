"""Rig discovery and aggregation: find `tag:rig` peers, mirror each rig's C3 state,
and re-emit its C4 event stream. A rig that drops out is shown offline, never removed."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from .config import Settings
from .events import EventBus, iter_sse
from .tailnet import Peer, PeerSource

log = logging.getLogger(__name__)

# Events after which the rig's device/lease snapshot is stale and gets re-read.
_STATE_EVENTS = {"device", "lease", "verify", "evidence"}


class RigError(RuntimeError):
    pass


class RigClient:
    """HTTP client for one rig's control port (C3)."""

    def __init__(self, base_url: str, http: httpx.AsyncClient, mock_identity: str = "", read_timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self._http = http
        self._read_timeout = read_timeout
        self.headers = {"X-Mock-Node": mock_identity} if mock_identity else {}

    async def state(self) -> dict[str, Any]:
        r = await self._http.get(f"{self.base_url}/v1/state", headers=self.headers)
        r.raise_for_status()
        return r.json()

    async def events(self) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        timeout = httpx.Timeout(10.0, read=self._read_timeout)
        async with self._http.stream("GET", f"{self.base_url}/v1/events", headers=self.headers,
                                     timeout=timeout) as r:
            r.raise_for_status()
            async for name, data in iter_sse(r.aiter_lines()):
                try:
                    payload = json.loads(data)
                except ValueError:
                    log.warning("rig %s sent non-JSON event %s", self.base_url, name)
                    continue
                if isinstance(payload, dict):
                    yield name, payload

    async def snapshot(self, device: str) -> tuple[bytes, str]:
        r = await self._http.get(f"{self.base_url}/v1/devices/{device}/snapshot.jpg", headers=self.headers)
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "image/jpeg")

    async def evidence(self, evidence_id: str) -> dict[str, Any] | None:
        r = await self._http.get(f"{self.base_url}/v1/evidence/{evidence_id}", headers=self.headers)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def evidence_file(self, evidence_id: str, name: str, max_bytes: int) -> bytes | None:
        async with self._http.stream("GET", f"{self.base_url}/v1/evidence/{evidence_id}/{name}",
                                     headers=self.headers) as r:
            if r.status_code == 404:
                return None
            r.raise_for_status()
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > max_bytes:
                    raise RigError(f"evidence file {name} exceeds {max_bytes} bytes")
            return bytes(buf)

    async def admin(self, path: str, body: dict[str, Any], operator: str = "") -> httpx.Response:
        headers = dict(self.headers)
        if operator:
            headers["X-Farm-Operator"] = operator
        return await self._http.post(f"{self.base_url}/v1/admin/{path}", json=body, headers=headers)


class RigConn:
    """One rig: mirrored C3 snapshot plus a live subscription to its event stream."""

    def __init__(self, peer: Peer, client: RigClient, bus: EventBus,
                 on_change: Callable[[], None], on_evidence: Callable[[str, str], Awaitable[None]]):
        self.peer = peer
        self.client = client
        self.rig_id = peer.hostname  # replaced by the rig's own rig_id after the first /v1/state
        self.online = False
        self.state: dict[str, Any] | None = None
        self._bus = bus
        self._on_change = on_change
        self._on_evidence = on_evidence
        self._task: asyncio.Task[None] | None = None
        self._refresh_task: asyncio.Task[None] | None = None
        self._refresh_lock = asyncio.Lock()
        self._background: set[asyncio.Task[None]] = set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"rig:{self.peer.hostname}")

    async def stop(self) -> None:
        for task in (self._task, self._refresh_task):
            if task is not None:
                task.cancel()
        for task in (self._task, self._refresh_task):
            if task is not None:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    async def refresh_state(self) -> dict[str, Any]:
        async with self._refresh_lock:
            state = await self.client.state()
            self.state = state
            self.rig_id = (state.get("rig") or {}).get("rig_id") or self.rig_id
            return state

    def _schedule_refresh(self) -> None:
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.create_task(self._debounced_refresh())

    async def _debounced_refresh(self) -> None:
        await asyncio.sleep(0.15)  # coalesce bursts (lease + device + run events arrive together)
        try:
            await self.refresh_state()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("rig %s state refresh failed: %s", self.rig_id, exc)

    def _set_online(self, online: bool) -> None:
        if online == self.online:
            return
        self.online = online
        if not online and self.state:
            for dev in self.state.get("devices", []):
                self._bus.publish("device", {"rig_id": self.rig_id, "device": dev.get("id"),
                                             "status": "offline", "queue_depth": 0})
        self._on_change()

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self.refresh_state()
                self._set_online(True)
                backoff = 1.0
                async for name, data in self.client.events():
                    await self._handle(name, data)
                log.info("rig %s event stream ended", self.rig_id)
            except asyncio.CancelledError:
                raise
            except (httpx.HTTPError, ValueError) as exc:
                log.info("rig %s unreachable: %s", self.rig_id, exc)
            except Exception:  # a malformed rig must not kill its subscription for good
                log.exception("rig %s: unexpected error; reconnecting", self.rig_id)
            self._set_online(False)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10.0)

    async def _handle(self, name: str, data: dict[str, Any]) -> None:
        data.setdefault("rig_id", self.rig_id)
        if name == "rig_health" and self.state is not None:
            rig = self.state.setdefault("rig", {})
            for key in ("temp_c", "load1", "mem_free_mb", "throttled", "camera_ok", "verifier_online"):
                if key in data:
                    rig[key] = data[key]
        if name in _STATE_EVENTS:
            self._schedule_refresh()
        if name == "evidence" and data.get("evidence_id"):
            task = asyncio.create_task(self._on_evidence(self.rig_id, str(data["evidence_id"])))
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        self._bus.publish(name, data)


class RigRegistry:
    def __init__(self, settings: Settings, peers: PeerSource, bus: EventBus, http: httpx.AsyncClient,
                 on_change: Callable[[], None], on_evidence: Callable[[str, str], Awaitable[None]]):
        self.settings = settings
        self._peers = peers
        self._bus = bus
        self._http = http
        self._on_change = on_change
        self._on_evidence = on_evidence
        self.conns: dict[str, RigConn] = {}  # keyed by peer hostname
        self.online_hosts: set[str] = set()  # every online peer hostname (sessions included)
        self.last_error: str = ""
        self._task: asyncio.Task[None] | None = None

    def _url_for(self, peer: Peer) -> str | None:
        if peer.url:
            return peer.url
        ip = peer.ipv4()
        return f"http://{ip}:{self.settings.rig_control_port}" if ip else None

    async def discover_once(self) -> None:
        try:
            peers = await self._peers.peers()
            self.last_error = ""
        except Exception as exc:  # tailscale missing/stopped: keep the last known picture
            self.last_error = str(exc)
            log.warning("peer discovery failed: %s", exc)
            return
        self.online_hosts = {p.hostname for p in peers if p.online}
        for peer in peers:
            if self.settings.rig_tag not in peer.tags:
                continue
            url = self._url_for(peer)
            if url is None:
                continue
            conn = self.conns.get(peer.hostname)
            if conn is not None and conn.client.base_url == url.rstrip("/"):
                conn.peer = peer
                continue
            if conn is not None:
                await conn.stop()
            client = RigClient(url, self._http, self.settings.mock_identity, self.settings.rig_read_timeout_s)
            conn = RigConn(peer, client, self._bus, self._on_change, self._on_evidence)
            self.conns[peer.hostname] = conn
            conn.start()
            self._on_change()

    async def _loop(self) -> None:
        while True:
            await self.discover_once()
            await asyncio.sleep(self.settings.discovery_interval_s)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="rig-discovery")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for conn in self.conns.values():
            await conn.stop()

    def get(self, rig_id: str) -> RigConn | None:
        return next((c for c in self.conns.values() if c.rig_id == rig_id), None)

    def all(self) -> list[RigConn]:
        return sorted(self.conns.values(), key=lambda c: c.rig_id)
