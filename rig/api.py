"""HTTP surfaces: C1 session API (:8080) and C3 control API + C4 events (:8081) over one Rig."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse

from .engine import Dev, Lease, Rig, RigAPIError, Verify
from .identity import Caller, IdentityError


def encode_sse(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def _app(rig: Rig, title: str) -> FastAPI:
    app = FastAPI(title=title, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RigAPIError)
    async def _err(_: Request, exc: RigAPIError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code, "message": exc.message, "next": exc.next_call}},
                            status_code=exc.status)

    return app


async def caller_of(rig: Rig, request: Request) -> Caller:
    ip = request.client.host if request.client else ""
    try:
        return await rig.identity.resolve(ip, {k.lower(): v for k, v in request.headers.items()})
    except IdentityError as e:
        raise RigAPIError(403, "not_on_tailnet", str(e), "join the tailnet with tag:devin-session") from None


def create_session_app(rig: Rig) -> FastAPI:
    """C1. Only sessions and operators; every lease-scoped call must come from the holder with the token."""
    app = _app(rig, f"rigd {rig.rig_id} session API")

    async def who(request: Request) -> str:
        return (await caller_of(rig, request)).node

    def device(dev_id: str) -> Dev:
        dev = rig.devices.get(dev_id)
        if dev is None:
            raise RigAPIError(404, "unknown", f"no device {dev_id}", "GET /v1/devices")
        return dev

    async def lease_for(request: Request, lease_id: str, token: bool = True) -> Lease:
        node = await who(request)
        lease = rig.leases.get(lease_id)
        if lease is None:
            raise RigAPIError(404, "unknown", f"no lease {lease_id}", "POST /v1/leases")
        if lease.holder != node:
            raise RigAPIError(403, "not_holder", "lease belongs to another node", "POST /v1/leases")
        if token:
            if lease.state != "active" or request.headers.get("X-Fencing-Token") != str(lease.token):
                raise RigAPIError(403, "stale_token", "fencing token is not current", "POST /v1/leases")
            rig.renew(lease)
        return lease

    @app.get("/v1/rig")
    async def get_rig(request: Request) -> dict[str, Any]:
        await who(request)
        return rig.rig_json()

    @app.get("/v1/devices")
    async def get_devices(request: Request) -> list[dict[str, Any]]:
        await who(request)
        return [rig.device_json(d) for d in rig.devices.values()]

    @app.get("/v1/devices/{dev_id}/describe", response_class=PlainTextResponse)
    async def describe(dev_id: str, request: Request) -> str:
        await who(request)
        return device(dev_id).driver.describe_md()

    @app.post("/v1/leases")
    async def acquire(request: Request) -> JSONResponse:
        node = await who(request)
        body = await _json(request)
        try:
            ttl = min(max(float(body.get("ttl_s", 300)), 1.0), 900.0)
            wait = min(max(float(body.get("wait_s", 20)), 0.0), 25.0)
        except (TypeError, ValueError):
            raise RigAPIError(422, "bad_request", "ttl_s and wait_s must be numbers") from None
        lease, granted = await rig.acquire(node, str(body.get("device", "")), ttl, wait)
        if granted:
            return JSONResponse({"lease_id": lease.lease_id, "device": lease.device, "token": lease.token,
                                 "expires_at": lease.expires_at, "max_hold_until": lease.max_hold_until})
        if lease.state != "queued":  # dropped/expired while waiting
            raise RigAPIError(409, "busy", f"lease {lease.state} while queued", "POST /v1/leases")
        return JSONResponse({"lease_id": lease.lease_id, "queued": True,
                             "position": rig.devices[lease.device].queue.index(lease) + 1}, status_code=202)

    @app.get("/v1/leases/{lease_id}")
    async def lease_status(lease_id: str, request: Request) -> dict[str, Any]:
        lease = await lease_for(request, lease_id, token=False)
        lease.last_poll = time.time()
        out = rig.lease_json(lease)
        out.pop("lease_id", None)
        out.pop("device", None)
        return out

    @app.post("/v1/leases/{lease_id}/renew")
    async def renew(lease_id: str, request: Request) -> dict[str, Any]:
        lease = await lease_for(request, lease_id)
        return {"expires_at": lease.expires_at}

    @app.post("/v1/leases/{lease_id}/run", status_code=202)
    async def run(lease_id: str, request: Request) -> dict[str, Any]:
        lease = await lease_for(request, lease_id)
        body = await _json(request)
        r = rig.start_run(lease, str(body.get("repo_url", "")), str(body.get("sha", "")), str(body.get("path", "")))
        return {"run_id": r.run_id}

    @app.get("/v1/runs/{run_id}")
    async def run_status(run_id: str, request: Request) -> dict[str, Any]:
        node = await who(request)
        r = rig.runs.get(run_id)
        if r is None:
            raise RigAPIError(404, "unknown", f"no run {run_id}")
        if rig.leases[r.lease_id].holder != node:
            raise RigAPIError(403, "not_holder", "run belongs to another node")
        out: dict[str, Any] = {"state": r.state}
        if r.build_time_s is not None:
            out["build_time_s"] = r.build_time_s
        if r.error:
            out["error"] = r.error
        return out

    @app.get("/v1/runs/{run_id}/logs")
    async def run_logs(run_id: str, request: Request, since: float = 0.0) -> dict[str, Any]:
        node = await who(request)
        r = rig.runs.get(run_id)
        if r is None:
            raise RigAPIError(404, "unknown", f"no run {run_id}")
        if rig.leases[r.lease_id].holder != node:
            raise RigAPIError(403, "not_holder", "run belongs to another node")
        lines = [ln for ln in r.logs if ln["ts"] > since]
        return {"lines": lines, "next": lines[-1]["ts"] if lines else since}

    @app.post("/v1/leases/{lease_id}/verify", status_code=202)
    async def verify(lease_id: str, request: Request) -> dict[str, Any]:
        lease = await lease_for(request, lease_id)
        body = await _json(request)
        assertions = body.get("assertions") or []
        if not isinstance(assertions, list) or not all(isinstance(a, dict) for a in assertions):
            raise RigAPIError(422, "bad_request", "assertions must be a list of objects")
        try:
            duration = min(max(float(body.get("duration_s", 10)), 1.0), 30.0)
        except (TypeError, ValueError):
            raise RigAPIError(422, "bad_request", "duration_s must be a number") from None
        import secrets
        v = Verify(verify_id=f"v-{secrets.token_hex(6)}", device=lease.device, lease_id=lease_id)
        rig.verifies[v.verify_id] = v
        rig.emit("verify", device=v.device, verify_id=v.verify_id, state="pending")
        rig.spawn(rig.run_verify(v, assertions, duration))
        return {"verify_id": v.verify_id}

    @app.get("/v1/verify/{verify_id}")
    async def verify_status(verify_id: str, request: Request, wait: float = 0.0) -> dict[str, Any]:
        node = await who(request)
        v = rig.verifies.get(verify_id)
        if v is None:
            raise RigAPIError(404, "unknown", f"no verify {verify_id}")
        if rig.leases[v.lease_id].holder != node:
            raise RigAPIError(403, "not_holder", "verify belongs to another node")
        if wait > 0 and not v.done.is_set():
            try:
                await asyncio.wait_for(v.done.wait(), timeout=min(wait, 25.0))
            except asyncio.TimeoutError:
                pass
        out: dict[str, Any] = {"state": v.state}
        if v.state == "done":
            out["results"] = v.results
            out["evidence"] = {"id": v.evidence_id, "local_url": f"/v1/evidence/{v.evidence_id}"}
        elif v.state == "error":
            out["error"] = v.error
        return out

    @app.post("/v1/leases/{lease_id}/release")
    async def release(lease_id: str, request: Request) -> dict[str, Any]:
        lease = await lease_for(request, lease_id, token=False)
        if lease.state == "active" and request.headers.get("X-Fencing-Token") != str(lease.token):
            raise RigAPIError(403, "stale_token", "fencing token is not current", "POST /v1/leases")
        rig._end(lease, "released")
        return {"ok": True}

    return app


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        raise RigAPIError(422, "bad_request", "body must be JSON") from None
    if not isinstance(body, dict):
        raise RigAPIError(422, "bad_request", "body must be a JSON object")
    return body


def create_control_app(rig: Rig) -> FastAPI:
    """C3 + C4: operators only (tag:control, team). Sessions get 403 not_team."""
    app = _app(rig, f"rigd {rig.rig_id} control API")

    async def operator(request: Request) -> Caller:
        c = await caller_of(rig, request)
        if not c.is_operator:
            raise RigAPIError(403, "not_team", "control API is for tag:control and team only")
        return c

    def device(dev_id: str) -> Dev:
        dev = rig.devices.get(dev_id)
        if dev is None:
            raise RigAPIError(404, "unknown", f"no device {dev_id}", "GET /v1/state")
        return dev

    # Read-only C1 views are also served here so one URL (the control port) shows the rig.
    @app.get("/v1/rig")
    async def get_rig(request: Request) -> dict[str, Any]:
        await operator(request)
        return rig.rig_json()

    @app.get("/v1/devices")
    async def get_devices(request: Request) -> list[dict[str, Any]]:
        await operator(request)
        return [rig.device_json(d) for d in rig.devices.values()]

    @app.get("/v1/state")
    async def state(request: Request) -> dict[str, Any]:
        await operator(request)
        return rig.state_json()

    @app.get("/v1/events")
    async def events(request: Request) -> StreamingResponse:
        await operator(request)
        q: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=2000)
        rig._subs.add(q)

        async def gen() -> Any:
            try:
                h = rig.health()
                yield encode_sse("rig_health", {**h, "rig_id": rig.rig_id, "ts": time.time()})
                for dev in rig.devices.values():
                    yield encode_sse("device", {"device": dev.id, "status": dev.status,
                                                "holder": dev.lease.holder if dev.lease else None,
                                                "queue_depth": len(dev.queue), "rig_id": rig.rig_id, "ts": time.time(),
                                                **({"reason": dev.reason} if dev.reason else {})})
                while True:
                    try:
                        name, data = await asyncio.wait_for(q.get(), timeout=10)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield encode_sse(name, data)
            finally:
                rig._subs.discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/v1/devices/{dev_id}/snapshot.jpg")
    async def snapshot(dev_id: str, request: Request) -> Response:
        await operator(request)
        device(dev_id)
        if not rig.snapshot_allowed(dev_id):
            raise RigAPIError(429, "rate_limited", "snapshots are limited to 1/s per device")
        data = await rig.snapshot(dev_id)
        if data is None:
            raise RigAPIError(503, "verifier_unavailable", "no camera frame available (verifier offline)")
        return Response(data, media_type="image/jpeg")

    @app.get("/v1/evidence/{evidence_id}")
    async def evidence(evidence_id: str, request: Request) -> Response:
        await operator(request)
        p = rig.evidence_file(evidence_id, "evidence.json")
        if p is None:
            raise RigAPIError(404, "unknown", "no such evidence")
        return Response(p.read_bytes(), media_type="application/json")

    @app.get("/v1/evidence/{evidence_id}/{name}")
    async def evidence_file(evidence_id: str, name: str, request: Request) -> Response:
        await operator(request)
        p = rig.evidence_file(evidence_id, name)
        if p is None:
            raise RigAPIError(404, "unknown", "no such file")
        media = {"jpg": "image/jpeg", "gif": "image/gif", "json": "application/json", "mp4": "video/mp4"}.get(
            name.rsplit(".", 1)[-1])
        return FileResponse(p, media_type=media or "application/octet-stream")

    @app.post("/v1/admin/maintenance")
    async def maintenance(request: Request) -> dict[str, Any]:
        await operator(request)
        rig.maintenance = bool((await _json(request)).get("on"))
        rig.emit("rig_health", **rig.health())
        return {"maintenance": rig.maintenance}

    @app.post("/v1/admin/devices/{dev_id}/reset")
    async def reset(dev_id: str, request: Request) -> dict[str, Any]:
        await operator(request)
        dev = device(dev_id)
        if dev.lease:
            rig._end(dev.lease, "revoked")
        elif dev.status != "resetting":
            rig._begin_handover(dev)
        return {"ok": True}

    @app.post("/v1/admin/leases/{lease_id}/revoke")
    async def revoke(lease_id: str, request: Request) -> dict[str, Any]:
        await operator(request)
        lease = rig.leases.get(lease_id)
        if lease is None:
            raise RigAPIError(404, "unknown", f"no lease {lease_id}")
        rig._end(lease, "revoked")
        return {"ok": True}

    return app
