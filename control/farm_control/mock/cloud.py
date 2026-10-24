"""Mock cloud: the subset of the Devin API v3 and the Tailscale API v2 that control uses, plus a mock
tailnet. Control talks to it over real HTTP with its real clients, so mock mode exercises the same code
paths as live mode. Each mock Devin session runs a scripted agent (mock/agent.py) against the mock rigs."""
from __future__ import annotations

import asyncio
import itertools
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..tailnet import Peer


@dataclass
class TailnetDevice:
    node_id: str
    hostname: str
    tags: list[str]
    ips: list[str]
    online: bool = True
    url: str | None = None


@dataclass
class MSession:
    session_id: str
    prompt: str
    title: str
    tags: list[str]
    max_acu: int | None
    secrets: dict[str, str]
    playbook_id: str | None
    payload: dict[str, Any] = field(default_factory=dict)  # the create request as received
    created_at: int = field(default_factory=lambda: int(time.time()))
    status: str = "new"
    status_detail: str | None = None
    acus: float = 0.0
    archived: bool = False
    structured_output: dict[str, Any] | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)
    inbox: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[Any] | None = None

    def json(self) -> dict[str, Any]:
        return {"session_id": self.session_id, "url": f"https://app.devin.ai/sessions/{self.session_id}",
                "status": self.status, "status_detail": self.status_detail, "tags": self.tags, "org_id": "org-mock",
                "created_at": self.created_at, "updated_at": int(time.time()), "acus_consumed": round(self.acus, 2),
                "pull_requests": [], "is_archived": self.archived, "title": self.title,
                "playbook_id": self.playbook_id, "structured_output": self.structured_output}


class MockWorld:
    """Shared mock state: tailnet devices, minted join keys, Devin sessions, and rig base URLs."""

    def __init__(self, speed: float = 1.0):
        self.speed = speed
        self.devices: dict[str, TailnetDevice] = {}
        self.keys: dict[str, dict[str, Any]] = {}  # key -> {id, tags, ephemeral, used, expires}
        self.sessions: dict[str, MSession] = {}
        self.rig_urls: dict[str, str] = {}  # rig hostname -> base URL (C1 and C3 share one port in mock)
        self._ip = itertools.count(10)
        self.access_tokens: set[str] = set()

    def add_rig(self, hostname: str, url: str) -> None:
        self.rig_urls[hostname] = url
        self.devices[hostname] = TailnetDevice(f"n{secrets.token_hex(5)}", hostname, ["tag:rig"],
                                               [f"100.64.0.{next(self._ip)}"], url=url)

    def join(self, authkey: str, hostname: str) -> TailnetDevice:
        """What `tailscale up --authkey=... --hostname=...` does: one-off keys work once, unexpired."""
        key = self.keys.get(authkey)
        if key is None or key["used"] or time.time() > key["expires"]:
            raise PermissionError("invalid, used or expired auth key")
        key["used"] = True
        dev = TailnetDevice(f"n{secrets.token_hex(5)}", hostname, list(key["tags"]), [f"100.64.1.{next(self._ip)}"])
        self.devices[hostname] = dev
        return dev

    def peers(self) -> list[Peer]:
        return [Peer(hostname=d.hostname, ips=d.ips, tags=d.tags, online=d.online, node_id=d.node_id, url=d.url)
                for d in self.devices.values()]


class MockPeerSource:
    """`tailscale status --json`, as seen from the control node of the mock tailnet."""

    def __init__(self, world: MockWorld):
        self.world = world

    async def peers(self) -> list[Peer]:
        return self.world.peers()


def create_cloud_app(world: MockWorld) -> FastAPI:
    from .agent import run_agent  # local import: agent imports this module

    app = FastAPI(title="mock cloud (Devin v3 + Tailscale v2)", docs_url=None, redoc_url=None, openapi_url=None)

    def problem(status: int, detail: str) -> JSONResponse:
        return JSONResponse({"type": "about:blank", "title": detail, "status": status, "detail": detail},
                            status_code=status)

    def devin_auth(request: Request) -> bool:
        return request.headers.get("Authorization", "").startswith("Bearer ") and \
            len(request.headers["Authorization"]) > len("Bearer ")

    def ts_auth(request: Request) -> bool:
        return request.headers.get("Authorization", "").removeprefix("Bearer ") in world.access_tokens

    def session(devin_id: str) -> MSession | None:
        return world.sessions.get(devin_id.removeprefix("devin-"))

    # ---- Devin API v3 -------------------------------------------------------------------------
    @app.post("/v3/organizations/{org_id}/sessions")
    async def create_session(org_id: str, request: Request) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        body = await request.json()
        if not body.get("prompt"):
            return problem(422, "prompt is required")
        s = MSession(session_id=secrets.token_hex(16), prompt=body["prompt"], title=body.get("title") or "",
                     tags=list(body.get("tags") or []), max_acu=body.get("max_acu_limit"),
                     secrets={x["key"]: x["value"] for x in body.get("session_secrets") or []},
                     playbook_id=body.get("playbook_id"), payload=body)
        world.sessions[s.session_id] = s
        s.task = asyncio.create_task(run_agent(world, s))
        return JSONResponse(s.json())

    @app.get("/v3/organizations/{org_id}/sessions")
    async def list_sessions(org_id: str, request: Request, first: int = 100) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        items = [s.json() for s in world.sessions.values()][:first]
        return JSONResponse({"items": items, "has_next_page": False, "end_cursor": None})

    @app.get("/v3/organizations/{org_id}/sessions/{devin_id}")
    async def get_session(org_id: str, devin_id: str, request: Request) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        s = session(devin_id)
        return JSONResponse(s.json()) if s else problem(404, "Session not found")

    @app.get("/v3/organizations/{org_id}/sessions/{devin_id}/messages")
    async def list_messages(org_id: str, devin_id: str, request: Request, after: str | None = None,
                            first: int = 100) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        s = session(devin_id)
        if s is None:
            return problem(404, "Session not found")
        start = int(after) + 1 if after else 0
        page = s.messages[start:start + first]
        end = start + len(page) - 1
        return JSONResponse({"items": page, "end_cursor": str(end) if page else after,
                             "has_next_page": end + 1 < len(s.messages)})

    @app.post("/v3/organizations/{org_id}/sessions/{devin_id}/messages")
    async def send_message(org_id: str, devin_id: str, request: Request) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        s = session(devin_id)
        if s is None:
            return problem(404, "Session not found")
        text = (await request.json()).get("message", "")
        s.messages.append({"event_id": secrets.token_hex(8), "message": text, "source": "user",
                           "created_at": int(time.time())})
        s.inbox.put_nowait(text)
        return JSONResponse(s.json())

    @app.post("/v3/organizations/{org_id}/sessions/{devin_id}/archive")
    async def archive(org_id: str, devin_id: str, request: Request) -> JSONResponse:
        if not devin_auth(request):
            return problem(401, "Unauthorized")
        s = session(devin_id)
        if s is None:
            return problem(404, "Session not found")
        s.archived, s.status, s.status_detail = True, "suspended", "user_request"
        if s.task:
            s.task.cancel()
        return JSONResponse(s.json())

    # ---- Tailscale API v2 ---------------------------------------------------------------------
    @app.post("/api/v2/oauth/token")
    async def oauth_token(request: Request) -> JSONResponse:
        form = parse_qs((await request.body()).decode())
        client_id, client_secret = form.get("client_id", [""])[0], form.get("client_secret", [""])[0]
        if not client_id or not client_secret:
            return JSONResponse({"message": "invalid client"}, status_code=401)
        token = f"mock-access-{secrets.token_hex(12)}"
        world.access_tokens.add(token)
        return JSONResponse({"access_token": token, "token_type": "Bearer", "expires_in": 3600})

    @app.post("/api/v2/tailnet/{tailnet}/keys")
    async def create_key(tailnet: str, request: Request) -> JSONResponse:
        if not ts_auth(request):
            return JSONResponse({"message": "unauthorized"}, status_code=401)
        body = await request.json()
        create = body["capabilities"]["devices"]["create"]
        key_id = f"k{secrets.token_hex(6)}"
        key = f"mock-authkey-{secrets.token_hex(16)}"
        world.keys[key] = {"id": key_id, "tags": create.get("tags", []), "ephemeral": create.get("ephemeral"),
                           "reusable": create.get("reusable"), "preauthorized": create.get("preauthorized"),
                           "used": False, "expires": time.time() + body.get("expirySeconds", 3600)}
        return JSONResponse({"id": key_id, "key": key, "created": time.time(), "capabilities": body["capabilities"]})

    @app.delete("/api/v2/tailnet/{tailnet}/keys/{key_id}")
    async def delete_key(tailnet: str, key_id: str, request: Request) -> JSONResponse:
        if not ts_auth(request):
            return JSONResponse({"message": "unauthorized"}, status_code=401)
        for k, meta in list(world.keys.items()):
            if meta["id"] == key_id:
                del world.keys[k]
        return JSONResponse({})

    @app.get("/api/v2/tailnet/{tailnet}/devices")
    async def list_devices(tailnet: str, request: Request) -> JSONResponse:
        if not ts_auth(request):
            return JSONResponse({"message": "unauthorized"}, status_code=401)
        return JSONResponse({"devices": [{"nodeId": d.node_id, "hostname": d.hostname,
                                          "name": f"{d.hostname}.mock.ts.net", "tags": d.tags,
                                          "addresses": d.ips} for d in world.devices.values()]})

    @app.delete("/api/v2/device/{node_id}")
    async def delete_device(node_id: str, request: Request) -> JSONResponse:
        if not ts_auth(request):
            return JSONResponse({"message": "unauthorized"}, status_code=401)
        for host, d in list(world.devices.items()):
            if d.node_id == node_id:
                del world.devices[host]
                return JSONResponse({})
        return JSONResponse({"message": "not found"}, status_code=404)

    return app
