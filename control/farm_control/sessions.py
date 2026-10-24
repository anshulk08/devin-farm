"""Devin sessions driven by control: create (join key + secrets), poll status/messages,
prompt, stop (archive + revoke leases + delete node), and the global ACU budget guard."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Settings
from .devin import DevinClient, DevinError
from .errors import ControlError
from .events import EventBus
from .graph import SessionView
from .rigs import RigRegistry
from .store import Store
from .tailnet import TailscaleAPI, TailscaleAPIError, farm_id_from_node
from .tickets import Ticket, TicketCatalog

log = logging.getLogger(__name__)

TERMINAL = {"exit", "error"}
MAX_MESSAGES = 500


@dataclass
class Session:
    farm_id: str
    devin_session_id: str
    ticket_id: str
    title: str
    url: str
    max_acu: int
    created_at: float
    device_hint: str | None = None
    status: str = "new"
    status_detail: str | None = None
    acus: float = 0.0
    archived: bool = False
    structured_output: dict[str, Any] | None = None
    msg_cursor: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)

    @property
    def node_name(self) -> str:
        return f"devin-{self.farm_id}"

    @property
    def live(self) -> bool:
        return not self.archived and self.status not in TERMINAL

    def ui_status(self) -> str:
        if self.archived:
            return "archived"
        if self.status == "running":
            return self.status_detail if self.status_detail and self.status_detail != "working" else "running"
        if self.status in ("new", "claimed", "resuming"):
            return "starting"
        return "finished" if self.status == "exit" else self.status

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Session:
        names = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


def build_prompt(ticket: Ticket, farm_id: str, device_hint: str | None, extra: str | None,
                 kit_repo: str, public_url: str) -> str:
    lines = [ticket.text.rstrip(), "", "---", "Devin Farm session",
             f"Farm ID: {farm_id}", f"Device type: {ticket.device_type}"]
    if device_hint:
        lines.append(f"Device hint: {device_hint}")
    lines += [
        "",
        "Setup (once): git clone --depth 1 " + kit_repo + " /tmp/devin-farm && "
        "bash /tmp/devin-farm/session-kit/farm-join.sh && export PATH=/tmp/devin-farm/session-kit:$PATH",
        "Then follow /tmp/devin-farm/session-kit/SKILL.md: lease a device, run your SHA, verify with the camera, "
        "read the measured results, iterate, and always release the lease.",
        "Only claim success if a camera-verified `farm verify` passed on your final SHA.",
    ]
    if public_url:
        lines.append(f"Evidence links for the PR: {public_url}/e/<evidence_id>")
    if extra:
        lines += ["", extra.strip()]
    return "\n".join(lines) + "\n"


class SessionManager:
    def __init__(self, settings: Settings, bus: EventBus, store: Store, registry: RigRegistry,
                 tickets: TicketCatalog, devin: DevinClient | None, tsapi: TailscaleAPI | None,
                 on_change: Any = None):
        self.settings = settings
        self._bus = bus
        self._store = store
        self._registry = registry
        self.tickets = tickets
        self.devin = devin
        self.tsapi = tsapi
        self._on_change = on_change or (lambda: None)
        self._sessions: dict[str, Session] = {}
        self._online: set[str] = set()
        self._create_lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._background: set[asyncio.Task[None]] = set()
        for d in store.load_sessions():
            s = Session.from_dict(d)
            self._sessions[s.farm_id] = s

    # ---- queries -------------------------------------------------------------------------
    def get(self, farm_id: str) -> Session:
        s = self._sessions.get(farm_id)
        if s is None:
            raise ControlError(404, "unknown", f"no session {farm_id}")
        return s

    def all(self) -> list[Session]:
        return sorted(self._sessions.values(), key=lambda s: s.created_at)

    def budget(self) -> dict[str, Any]:
        sessions = self._sessions.values()
        used = sum(s.acus for s in sessions)
        # A live session may still spend up to its own cap, so it is reserved at that cap.
        committed = sum(max(s.acus, s.max_acu) if s.live else s.acus for s in sessions)
        return {"acus_used": round(used, 2), "acus_cap": self.settings.acu_cap,
                "sessions_live": sum(1 for s in sessions if s.live), "acus_committed": round(committed, 2)}

    def leases_of(self, s: Session) -> list[dict[str, Any]]:
        out = []
        for conn in self._registry.all():
            for dev in (conn.state or {}).get("devices", []) if conn.online else []:
                lease = dev.get("lease") or {}
                if farm_id_from_node(lease.get("holder", "")) == s.farm_id:
                    out.append({"rig_id": conn.rig_id, "device": dev.get("id"), "lease_id": lease.get("lease_id"),
                                "state": "active", "token": lease.get("token"), "expires_at": lease.get("expires_at")})
                for q in dev.get("queue") or []:
                    if farm_id_from_node(q.get("holder", "")) == s.farm_id:
                        out.append({"rig_id": conn.rig_id, "device": dev.get("id"), "lease_id": q.get("lease_id"),
                                    "state": "queued", "position": q.get("position")})
        return out

    def view(self, s: Session) -> dict[str, Any]:
        return {
            "farm_id": s.farm_id, "devin_session_id": s.devin_session_id, "title": s.title,
            "ticket_id": s.ticket_id, "status": s.ui_status(), "devin_status": s.status,
            "status_detail": s.status_detail, "acus": s.acus, "max_acu": s.max_acu, "node_name": s.node_name,
            "online": s.farm_id in self._online, "leases": self.leases_of(s), "url": s.url,
            "created_at": s.created_at, "archived": s.archived, "structured_output": s.structured_output,
        }

    def graph_views(self) -> list[SessionView]:
        return [SessionView(farm_id=s.farm_id, title=s.title, ticket_id=s.ticket_id, status=s.ui_status(),
                            data={"acus": s.acus, "online": s.farm_id in self._online, "url": s.url,
                                  "node_name": s.node_name, "devin_session_id": s.devin_session_id,
                                  "max_acu": s.max_acu})
                for s in self.all() if not s.archived]

    # ---- mutations -----------------------------------------------------------------------
    def _save(self, s: Session) -> None:
        self._store.save_session(s.farm_id, s.created_at, dataclasses.asdict(s))

    def _publish(self, s: Session) -> None:
        self._bus.publish("session", {
            "farm_id": s.farm_id, "devin_session_id": s.devin_session_id, "node_name": s.node_name,
            "status": s.ui_status(), "acus": s.acus, "title": s.title, "url": s.url,
            "online": s.farm_id in self._online, "ticket_id": s.ticket_id})

    def _claim_schema(self) -> dict[str, Any] | None:
        path = self.settings.claim_schema_path
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

    async def create(self, ticket_id: str, device_hint: str | None = None, mode: str | None = None,
                     max_acu: int | None = None, extra_prompt: str | None = None) -> Session:
        if self.devin is None:
            raise ControlError(503, "not_configured", "Devin API not configured (DEVIN_API_KEY, DEVIN_ORG_ID)")
        if self.tsapi is None:
            raise ControlError(503, "not_configured",
                               "Tailscale OAuth client not configured (TS_OAUTH_CLIENT_ID, TS_OAUTH_CLIENT_SECRET)")
        ticket = self.tickets.get(ticket_id)
        if ticket is None:
            raise ControlError(404, "unknown_ticket", f"no ticket {ticket_id!r} under {self.settings.tickets_dir}")
        cap = int(max_acu if max_acu is not None else self.settings.default_max_acu)
        if cap <= 0:
            raise ControlError(422, "invalid", "max_acu must be a positive integer")

        async with self._create_lock:
            budget = self.budget()
            if budget["acus_committed"] + cap > self.settings.acu_cap:
                raise ControlError(409, "budget_exceeded",
                                   f"ACU budget: {budget['acus_committed']} committed + {cap} requested "
                                   f"> cap {self.settings.acu_cap}")
            farm_id = f"s-{secrets.token_hex(4)}"
            while farm_id in self._sessions:
                farm_id = f"s-{secrets.token_hex(4)}"
            try:
                key_id, key = await self.tsapi.mint_session_key(farm_id, self.settings.session_tag)
            except (TailscaleAPIError, httpx.HTTPError) as exc:
                raise ControlError(502, "tailscale_error", f"minting join key failed: {exc}") from exc

            secrets_in = [{"key": "TS_AUTHKEY", "value": key, "sensitive": True},
                          {"key": "FARM_ID", "value": farm_id, "sensitive": False}]
            if self.settings.public_url:
                secrets_in.append({"key": "FARM_EVIDENCE_BASE", "value": self.settings.public_url, "sensitive": False})
            title = f"farm {ticket.ticket_id} {farm_id}"
            payload: dict[str, Any] = {
                "prompt": build_prompt(ticket, farm_id, device_hint, extra_prompt,
                                       self.settings.kit_repo, self.settings.public_url),
                "title": title,
                "max_acu_limit": cap,
                "tags": ["farm", f"farm:{farm_id}", f"ticket:{ticket.ticket_id}"],
                "session_secrets": secrets_in,
            }
            if self.settings.playbook_id:
                payload["playbook_id"] = self.settings.playbook_id
            if mode:
                payload["devin_mode"] = mode
            if self.settings.tickets_repo:
                payload["repos"] = [self.settings.tickets_repo]
            schema = self._claim_schema()
            if schema is not None:
                payload["structured_output_schema"] = schema
            try:
                resp = await self.devin.create_session(payload)
            except (DevinError, httpx.HTTPError) as exc:
                try:
                    await self.tsapi.delete_key(key_id)
                except (TailscaleAPIError, httpx.HTTPError):
                    log.warning("could not delete unused join key for %s", farm_id)
                raise ControlError(502, "devin_error", f"create session failed: {exc}") from exc

            s = Session(farm_id=farm_id, devin_session_id=resp["session_id"], ticket_id=ticket.ticket_id,
                        title=title, url=resp.get("url", ""), max_acu=cap, created_at=time.time(),
                        device_hint=device_hint, status=resp.get("status", "new"),
                        status_detail=resp.get("status_detail"), acus=float(resp.get("acus_consumed") or 0))
            self._sessions[farm_id] = s
            self._save(s)
        self._publish(s)
        self._on_change()
        return s

    async def send_message(self, farm_id: str, text: str) -> None:
        s = self.get(farm_id)
        if s.archived:
            raise ControlError(409, "archived", f"session {farm_id} is archived")
        if self.devin is None:
            raise ControlError(503, "not_configured", "Devin API not configured")
        try:
            await self.devin.send_message(s.devin_session_id, text)
        except (DevinError, httpx.HTTPError) as exc:
            raise ControlError(502, "devin_error", f"send message failed: {exc}") from exc
        task = asyncio.create_task(self._poll_session(s))  # surface the echo + reply without waiting a cycle
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def stop(self, farm_id: str, operator: str = "") -> dict[str, Any]:
        """Archive the Devin session, revoke its leases and queue slots on every rig, delete its node."""
        s = self.get(farm_id)
        result: dict[str, Any] = {"farm_id": farm_id, "archived": s.archived, "revoked": [],
                                  "node_deleted": False, "errors": []}
        if self.devin is not None and not s.archived:
            try:
                await self.devin.archive(s.devin_session_id)
                s.archived = result["archived"] = True
            except (DevinError, httpx.HTTPError) as exc:
                result["errors"].append(f"archive: {exc}")
        elif self.devin is None:
            result["errors"].append("archive: Devin API not configured")

        for conn in self._registry.all():
            if not conn.online:
                continue
            try:
                state = await conn.refresh_state()
            except (httpx.HTTPError, ValueError) as exc:
                result["errors"].append(f"{conn.rig_id}: state: {exc}")
                continue
            for dev in state.get("devices", []):
                held = [dev.get("lease") or {}] + list(dev.get("queue") or [])
                for lease in held:
                    if farm_id_from_node(lease.get("holder", "")) != farm_id or not lease.get("lease_id"):
                        continue
                    try:
                        r = await conn.client.admin(f"leases/{lease['lease_id']}/revoke", {}, operator)
                        if r.status_code < 400:
                            result["revoked"].append({"rig_id": conn.rig_id, "device": dev.get("id"),
                                                      "lease_id": lease["lease_id"]})
                        else:
                            result["errors"].append(f"{conn.rig_id}: revoke {lease['lease_id']}: HTTP {r.status_code}")
                    except httpx.HTTPError as exc:
                        result["errors"].append(f"{conn.rig_id}: revoke {lease['lease_id']}: {exc}")
            if any(r["rig_id"] == conn.rig_id for r in result["revoked"]):
                try:  # so the graph broadcast below no longer shows the revoked leases
                    await conn.refresh_state()
                except (httpx.HTTPError, ValueError):
                    pass

        if self.tsapi is not None:
            try:
                result["node_deleted"] = await self.tsapi.delete_nodes(s.node_name) > 0
            except (TailscaleAPIError, httpx.HTTPError) as exc:
                result["errors"].append(f"delete node: {exc}")
        else:
            result["errors"].append("delete node: Tailscale OAuth client not configured")

        result["ok"] = not result["errors"]
        self._save(s)
        self._publish(s)
        self._on_change()
        return result

    # ---- polling -------------------------------------------------------------------------
    async def _poll_session(self, s: Session) -> None:
        assert self.devin is not None
        try:
            info = await self.devin.get_session(s.devin_session_id)
        except (DevinError, httpx.HTTPError) as exc:
            log.warning("poll %s failed: %s", s.farm_id, exc)
            return
        before = (s.status, s.status_detail, s.acus, s.archived, s.url, s.structured_output)
        s.status = info.get("status", s.status)
        s.status_detail = info.get("status_detail")
        s.acus = float(info.get("acus_consumed") or s.acus)
        s.archived = bool(info.get("is_archived", s.archived))
        s.url = info.get("url") or s.url
        s.structured_output = info.get("structured_output") or s.structured_output
        changed = before != (s.status, s.status_detail, s.acus, s.archived, s.url, s.structured_output)

        seen = {m["event_id"] for m in s.messages}
        after = s.msg_cursor
        try:
            while True:
                page = await self.devin.list_messages(s.devin_session_id, after=after, first=100)
                for item in page.get("items") or []:
                    if item.get("event_id") in seen:
                        continue
                    seen.add(item.get("event_id"))
                    msg = {"event_id": item.get("event_id"), "source": item.get("source", "devin"),
                           "text": item.get("message", ""), "ts": item.get("created_at", time.time())}
                    s.messages.append(msg)
                    self._bus.publish("session_message", {"farm_id": s.farm_id, "source": msg["source"],
                                                          "text": msg["text"], "ts": msg["ts"]})
                    changed = True
                cursor = page.get("end_cursor")
                if cursor:
                    after = cursor
                if not page.get("has_next_page") or not cursor:
                    break
        except (DevinError, httpx.HTTPError) as exc:
            log.warning("messages %s failed: %s", s.farm_id, exc)
        s.msg_cursor = after
        del s.messages[:-MAX_MESSAGES]
        if changed:
            self._save(s)
            self._publish(s)

    async def poll_once(self) -> None:
        online = {fid for fid in map(farm_id_from_node, self._registry.online_hosts) if fid}
        flipped = {fid for fid in online ^ self._online if fid in self._sessions}
        self._online = online
        for fid in flipped:
            self._publish(self._sessions[fid])
        if self.devin is None:
            return
        live = [s for s in self._sessions.values() if s.live]
        await asyncio.gather(*(self._poll_session(s) for s in live))

    async def _loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception:
                log.exception("session poll failed")
            await asyncio.sleep(self.settings.devin_poll_interval_s)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="devin-poller")

    async def stop_polling(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
