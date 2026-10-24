"""The control plane process: wiring (Control) plus the two HTTP surfaces (C10).

- Operator app: tailnet-only (behind `tailscale serve`), team identity from `Tailscale-User-Login`.
- Public app: read-only (behind Funnel): map, events without transcripts, thumbnails, evidence pages.
Both bind 127.0.0.1; tailscale serve/funnel are the only way in."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings
from .devin import DevinClient
from .errors import ControlError
from .events import Event, EventBus, Recorder, encode_sse
from .evidence import CONTENT_TYPES, EvidenceStore, render_page, render_web_page
from .graph import RigView, build_graph
from .rigs import RigConn, RigRegistry
from .sessions import SessionManager
from .store import Store
from .tailnet import PeerSource, TailscaleAPI
from .tickets import TicketCatalog

log = logging.getLogger(__name__)

KEEPALIVE_S = 15.0
SNAPSHOT_MIN_INTERVAL_S = 1.0
ADMIN_PATH = re.compile(r"^(maintenance|devices/[A-Za-z0-9_-]+/reset|leases/[A-Za-z0-9_-]+/revoke)$")  # C3 admin


class SnapshotCache:
    """At most one rig fetch per device per second, shared by every viewer (rigd rate-limits 1/s)."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], tuple[float, bytes, str]] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def get(self, conn: RigConn, device: str, max_age: float = SNAPSHOT_MIN_INTERVAL_S) -> tuple[bytes, str]:
        key = (conn.rig_id, device)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self._entries.get(key)
            if hit and time.monotonic() - hit[0] < max_age:
                return hit[1], hit[2]
            data, ctype = await conn.client.snapshot(device)
            self._entries[key] = (time.monotonic(), data, ctype)
            return data, ctype


class Control:
    def __init__(self, settings: Settings, peers: PeerSource, http: httpx.AsyncClient | None = None):
        self.settings = settings
        self.http = http or httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0))
        self.store = Store(settings.var_dir / "control.db")
        self.recorder = Recorder(settings.var_dir)
        self.bus = EventBus(self.recorder)
        self.registry = RigRegistry(settings, peers, self.bus, self.http,
                                    on_change=self.broadcast_graph, on_evidence=self._on_evidence)
        self.evidence = EvidenceStore(settings.var_dir / "evidence", self.store, self.registry)
        devin = (DevinClient(settings.devin_api_base, settings.devin_api_key, settings.devin_org_id, self.http)
                 if settings.devin_configured else None)
        tsapi = (TailscaleAPI(settings.ts_api_base, settings.ts_client_id, settings.ts_client_secret, self.http,
                              settings.ts_tailnet) if settings.tailscale_api_configured else None)
        self.sessions = SessionManager(settings, self.bus, self.store, self.registry,
                                       TicketCatalog(settings.tickets_dir), devin, tsapi,
                                       on_change=self.broadcast_graph)
        self.snapshots = SnapshotCache()

    async def _on_evidence(self, rig_id: str, evidence_id: str) -> None:
        await self.evidence.ingest(rig_id, evidence_id)

    def graph(self, public: bool = False) -> dict[str, Any]:
        rigs = [RigView(c.rig_id, c.online, c.state) for c in self.registry.all()]
        return build_graph(rigs, self.sessions.graph_views(), public=public, mode=self.settings.mode)

    def broadcast_graph(self) -> None:
        # Structural change (rig up/down/new, session created/stopped): clients replace their graph.
        self.bus.publish("graph_snapshot", self.graph())

    def rig(self, rig_id: str) -> RigConn:
        conn = self.registry.get(rig_id)
        if conn is None:
            raise ControlError(404, "unknown", f"no rig {rig_id}")
        if not conn.online:
            raise ControlError(409, "rig_offline", f"rig {rig_id} is offline")
        return conn

    async def start(self, background: bool = True) -> None:
        await self.registry.discover_once()
        if background:
            self.registry.start()
            self.sessions.start()

    async def stop(self) -> None:
        await self.sessions.stop_polling()
        await self.registry.stop()
        await self.http.aclose()
        self.recorder.close()
        self.store.close()


# ---- shared HTTP pieces -------------------------------------------------------------------

def public_event(event: Event) -> Event | None:
    """Public stream: no transcripts (messages, run logs), sessions reduced to ticket + status."""
    if event.name in ("session_message", "log"):
        return None
    if event.name == "session":
        d = event.data
        return Event("session", {"farm_id": d.get("farm_id"), "status": d.get("status"), "acus": d.get("acus"),
                                 "online": d.get("online"), "title": d.get("ticket_id"),
                                 "ticket_id": d.get("ticket_id"), "ts": d.get("ts")})
    return event


async def sse_stream(ctl: Control, request: Request, public: bool) -> AsyncIterator[str]:
    sub = ctl.bus.subscribe()  # subscribe before the snapshot so nothing falls in between
    try:
        yield encode_sse("graph_snapshot", ctl.graph(public=public))
        while not sub.dropped or not sub.queue.empty():
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(sub.queue.get(), timeout=KEEPALIVE_S)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if event.name == "graph_snapshot" and public:
                event = Event("graph_snapshot", ctl.graph(public=True))
            elif public:
                event = public_event(event)
                if event is None:
                    continue
            yield encode_sse(event.name, event.data)
    finally:
        ctl.bus.unsubscribe(sub)


def _sse_response(gen: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _install_common(app: FastAPI, ctl: Control, web_dist: Path) -> None:
    @app.exception_handler(ControlError)
    async def _control_error(_: Request, exc: ControlError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    @app.get("/e/{evidence_id}", response_class=HTMLResponse)
    async def evidence_page(evidence_id: str) -> HTMLResponse:
        doc = await ctl.evidence.get(evidence_id)
        if doc is None:
            raise ControlError(404, "unknown", "no such evidence")
        files, public_url = ctl.evidence.files(evidence_id), ctl.settings.public_url
        template = web_dist / "evidence.html"
        if template.is_file():
            return HTMLResponse(render_web_page(template.read_text(encoding="utf-8"), evidence_id, doc, files, public_url))
        return HTMLResponse(render_page(evidence_id, doc, files, public_url))

    @app.get("/e/{evidence_id}/{name}")
    async def evidence_file(evidence_id: str, name: str) -> FileResponse:
        if await ctl.evidence.get(evidence_id) is None:
            raise ControlError(404, "unknown", "no such evidence")
        path = ctl.evidence.file(evidence_id, name)
        if path is None:
            raise ControlError(404, "unknown", "no such file")
        return FileResponse(path, media_type=CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
                            headers={"Cache-Control": "public, max-age=86400, immutable"})


def _mount_web(app: FastAPI, dist: Path) -> None:
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
        return

    @app.get("/", include_in_schema=False)
    async def _no_build() -> Response:
        return Response(f"web build not found at {dist} (built by Lane D: `cd web && npm run build`)\n",
                        status_code=503, media_type="text/plain")


# ---- operator app -------------------------------------------------------------------------

class CreateSession(BaseModel):
    ticket_id: str
    device_hint: str | None = None
    mode: str | None = "normal"
    max_acu: int | None = Field(default=None, gt=0)
    extra_prompt: str | None = None


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


def create_operator_app(ctl: Control) -> FastAPI:
    app = FastAPI(title="farm-control operator", docs_url="/api/docs", openapi_url="/api/openapi.json")
    settings = ctl.settings

    def operator(request: Request) -> str:
        login = (request.headers.get("Tailscale-User-Login") or "").strip().lower()
        if settings.operator_auth == "open":
            return login or "mock-operator"
        if not login:
            raise ControlError(403, "not_operator", "operator API is reachable only through tailscale serve "
                                                    "from a team member's device")
        if login not in settings.team_logins:
            raise ControlError(403, "not_operator", f"{login} is not in FARM_TEAM_LOGINS")
        return login

    _install_common(app, ctl, settings.web_dist)
    auth = [Depends(operator)]

    @app.get("/api/graph", dependencies=auth)
    async def graph() -> dict[str, Any]:
        return ctl.graph()

    @app.get("/api/events", dependencies=auth)
    async def events(request: Request) -> StreamingResponse:
        return _sse_response(sse_stream(ctl, request, public=False))

    @app.get("/api/sessions", dependencies=auth)
    async def sessions() -> list[dict[str, Any]]:
        return [ctl.sessions.view(s) for s in ctl.sessions.all()]

    @app.get("/api/sessions/{farm_id}/messages", dependencies=auth)
    async def messages(farm_id: str) -> list[dict[str, Any]]:
        s = ctl.sessions.get(farm_id)
        return [{"source": m["source"], "text": m["text"], "ts": m["ts"]} for m in s.messages]

    @app.post("/api/sessions", dependencies=auth)
    async def create(body: CreateSession) -> dict[str, Any]:
        s = await ctl.sessions.create(body.ticket_id, body.device_hint, body.mode, body.max_acu, body.extra_prompt)
        return {"farm_id": s.farm_id, "devin_session_id": s.devin_session_id}

    @app.post("/api/sessions/{farm_id}/message", dependencies=auth)
    async def message(farm_id: str, body: MessageIn) -> dict[str, Any]:
        await ctl.sessions.send_message(farm_id, body.text)
        return {"ok": True}

    @app.post("/api/sessions/{farm_id}/stop")
    async def stop(farm_id: str, who: str = Depends(operator)) -> dict[str, Any]:
        return await ctl.sessions.stop(farm_id, who)

    @app.post("/api/rigs/{rig_id}/devices/{device}/poll", dependencies=auth)
    async def poll(rig_id: str, device: str) -> dict[str, Any]:
        conn = ctl.rig(rig_id)
        try:
            state = await conn.refresh_state()
        except (httpx.HTTPError, ValueError) as exc:
            raise ControlError(502, "rig_error", f"{rig_id}: {exc}") from exc
        dev = next((d for d in state.get("devices", []) if d.get("id") == device), None)
        if dev is None:
            raise ControlError(404, "unknown", f"no device {device} on {rig_id}")
        return {"state": dev, "rig": state.get("rig"), "camera": state.get("camera"),
                "snapshot_url": f"/api/rigs/{rig_id}/devices/{device}/snapshot.jpg?t={int(time.time() * 1000)}"}

    @app.get("/api/rigs/{rig_id}/devices/{device}/snapshot.jpg", dependencies=auth)
    async def snapshot(rig_id: str, device: str) -> Response:
        return await _snapshot(ctl, rig_id, device)

    @app.post("/api/rigs/{rig_id}/admin/{path:path}")
    async def admin(rig_id: str, path: str, request: Request, who: str = Depends(operator)) -> Response:
        if not ADMIN_PATH.match(path):
            raise ControlError(404, "unknown", f"no admin endpoint {path}")
        conn = ctl.rig(rig_id)
        body = await request.json() if await request.body() else {}
        try:
            r = await conn.client.admin(path, body, who)
        except httpx.HTTPError as exc:
            raise ControlError(502, "rig_error", f"{rig_id}: {exc}") from exc
        return Response(r.content, status_code=r.status_code,
                        media_type=r.headers.get("content-type", "application/json"))

    @app.get("/api/budget", dependencies=auth)
    async def budget() -> dict[str, Any]:
        return ctl.sessions.budget()

    @app.get("/api/tickets", dependencies=auth)
    async def tickets() -> list[dict[str, Any]]:
        return [{"ticket_id": t.ticket_id, "title": t.title, "device_type": t.device_type,
                 "outputs": list(t.outputs)} for t in ctl.sessions.tickets.list()]

    _mount_web(app, settings.web_dist)
    return app


async def _snapshot(ctl: Control, rig_id: str, device: str) -> Response:
    conn = ctl.rig(rig_id)
    try:
        data, ctype = await ctl.snapshots.get(conn, device)
    except httpx.HTTPStatusError as exc:
        raise ControlError(exc.response.status_code, "rig_error", f"{rig_id}/{device}: snapshot unavailable") from exc
    except httpx.HTTPError as exc:
        raise ControlError(502, "rig_error", f"{rig_id}: {exc}") from exc
    return Response(data, media_type=ctype, headers={"Cache-Control": "no-store"})


# ---- public app ---------------------------------------------------------------------------

def create_public_app(ctl: Control) -> FastAPI:
    app = FastAPI(title="farm-control public", docs_url=None, redoc_url=None, openapi_url=None)
    _install_common(app, ctl, ctl.settings.web_public_dist)

    @app.get("/pub/graph")
    async def graph() -> dict[str, Any]:
        return ctl.graph(public=True)

    @app.get("/pub/events")
    async def events(request: Request) -> StreamingResponse:
        return _sse_response(sse_stream(ctl, request, public=True))

    @app.get("/pub/rigs/{rig_id}/devices/{device}/snapshot.jpg")
    async def snapshot(rig_id: str, device: str) -> Response:
        return await _snapshot(ctl, rig_id, device)

    _mount_web(app, ctl.settings.web_public_dist)
    return app
