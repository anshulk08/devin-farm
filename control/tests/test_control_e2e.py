"""Control against the mock stack over real HTTP: session lifecycle, budget, prompting, stop, evidence,
operator auth and the public surface."""
from __future__ import annotations

import asyncio
import dataclasses
import json

import httpx
import pytest
from conftest import eventually

from farm_control.app import create_operator_app, create_public_app
from farm_control.config import REPO_ROOT
from farm_control.serving import bind, serve

pytestmark = pytest.mark.anyio


def _world_session(farm, farm_id):
    return next(s for s in farm.world.sessions.values() if s.secrets.get("FARM_ID") == farm_id)


def _lease_edges(graph, farm_id):
    return [e for e in graph["edges"] if e["kind"] in ("lease", "queue") and e["source"] == f"session:{farm_id}"]


async def test_created_session_joins_with_its_one_off_key_and_shows_up_on_the_map(farm):
    r = await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "max_acu": 4, "device_hint": "pico-2"})
    assert r.status_code == 200, r.text
    farm_id = r.json()["farm_id"]
    ws = _world_session(farm, farm_id)

    assert ws.max_acu == 4
    assert ws.payload["structured_output_schema"] == json.loads(
        (REPO_ROOT / "session-kit" / "claim.schema.json").read_text())
    key = farm.world.keys[ws.secrets["TS_AUTHKEY"]]
    assert (key["reusable"], key["ephemeral"], key["preauthorized"], key["tags"]) == \
        (False, True, True, ["tag:devin-session"])
    assert "Device hint: pico-2" in ws.prompt

    # The scripted session joins as devin-<farm_id>, leases pico-2 on rig-2, and the map shows the lease.
    await eventually(lambda: any(e["kind"] == "lease" and e["target"] == "device:rig-2/pico-2"
                                 for e in _lease_edges(farm.ctl.graph(), farm_id)))
    with pytest.raises(PermissionError):  # one-off: the key cannot join a second node
        farm.world.join(ws.secrets["TS_AUTHKEY"], "devin-s-intruder")
    sessions = (await farm.op.get("/api/sessions")).json()
    mine = next(s for s in sessions if s["farm_id"] == farm_id)
    assert mine["online"] and mine["node_name"] == f"devin-{farm_id}"

    # It finishes: camera ✗ then ✓, releases, and its claim is surfaced.
    await eventually(lambda: farm.ctl.sessions.get(farm_id).structured_output, timeout=15)
    assert farm.ctl.sessions.get(farm_id).structured_output["claimed_success"] is True
    await eventually(lambda: not _lease_edges(farm.ctl.graph(), farm_id))


async def test_budget_guard_refuses_before_minting_or_spending(farm):
    cap = farm.settings.acu_cap
    r = await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "max_acu": int(cap) - 5})
    assert r.status_code == 200
    keys, sessions = len(farm.world.keys), len(farm.world.sessions)

    r = await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "max_acu": 6})
    assert r.status_code == 409 and r.json()["error"]["code"] == "budget_exceeded"
    assert (len(farm.world.keys), len(farm.world.sessions)) == (keys, sessions)

    r = await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "max_acu": 5})
    assert r.status_code == 200  # exactly at the cap is allowed
    budget = (await farm.op.get("/api/budget")).json()
    assert budget["acus_cap"] == cap and budget["sessions_live"] == 2


async def test_unknown_ticket_and_bad_acu_are_rejected(farm):
    assert (await farm.op.post("/api/sessions", json={"ticket_id": "nope"})).status_code == 404
    assert (await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "max_acu": 0})).status_code == 422


async def test_operator_prompt_reaches_the_session_and_messages_are_not_duplicated(farm):
    farm_id = (await farm.op.post("/api/sessions", json={"ticket_id": "unoq-scroll"})).json()["farm_id"]
    r = await farm.op.post(f"/api/sessions/{farm_id}/message", json={"text": "attach the GIF to the PR"})
    assert r.status_code == 200

    async def replied():
        msgs = (await farm.op.get(f"/api/sessions/{farm_id}/messages")).json()
        return any(m["source"] == "devin" and "attach the GIF" in m["text"] for m in msgs) and msgs

    await eventually(replied, timeout=15)
    for _ in range(3):  # extra poll cycles must not re-append messages already seen
        await farm.ctl.sessions.poll_once()
    msgs = (await farm.op.get(f"/api/sessions/{farm_id}/messages")).json()
    user = [m for m in msgs if m["source"] == "user"]
    assert [m["text"] for m in user] == ["attach the GIF to the PR"]
    assert len(msgs) == len(_world_session(farm, farm_id).messages)


async def test_stop_archives_revokes_every_lease_and_deletes_the_node(farm):
    # Two sessions on the same device: the second one queues behind the first.
    a = (await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "device_hint": "pico-1"})).json()["farm_id"]
    await eventually(lambda: any(e["kind"] == "lease" for e in _lease_edges(farm.ctl.graph(), a)))
    b = (await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink", "device_hint": "pico-1"})).json()["farm_id"]
    await eventually(lambda: any(e["kind"] == "queue" for e in _lease_edges(farm.ctl.graph(), b)))

    result = (await farm.op.post(f"/api/sessions/{b}/stop")).json()
    assert result["ok"] and result["archived"] and result["node_deleted"], result
    assert [r["device"] for r in result["revoked"]] == ["pico-1"]
    assert f"devin-{b}" not in farm.world.devices
    assert _world_session(farm, b).archived
    assert not _lease_edges(farm.ctl.graph(), b)
    assert not any(n["id"] == f"session:{b}" for n in farm.ctl.graph()["nodes"])
    # a still holds pico-1: stopping b did not touch it.
    assert any(e["kind"] == "lease" for e in _lease_edges(farm.ctl.graph(), a))


async def test_evidence_is_republished_with_a_preview_and_survives_the_rig_forgetting_it(farm):
    farm_id = (await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink"})).json()["farm_id"]
    await eventually(lambda: farm.ctl.sessions.get(farm_id).structured_output, timeout=15)
    eids = farm.ctl.sessions.get(farm_id).structured_output["evidence_ids"]
    await eventually(lambda: all(farm.ctl.evidence.file(e, "evidence.json") for e in eids))
    for rig in farm.stack.rigs:
        rig.evidence.clear()  # control serves its own copy

    fail, ok = eids
    page = await farm.pub.get(f"/e/{fail}")
    assert page.status_code == 200
    assert "contradicted by camera" in page.text and "og:image" in page.text
    assert "confirmed by camera" in (await farm.pub.get(f"/e/{ok}")).text
    frame = await farm.pub.get(f"/e/{ok}/frame-0.jpg")
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/jpeg"
    for bad in (f"/e/{ok}/control.db", "/e/short", f"/e/{ok}/..%2F..%2Fcontrol.db"):
        assert (await farm.pub.get(bad)).status_code == 404


async def test_operator_api_requires_a_team_login(farm):
    ctl = farm.ctl
    ctl.settings = dataclasses.replace(ctl.settings, operator_auth="tailscale",
                                       team_logins=frozenset({"adrian@example.com"}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_operator_app(ctl)),
                                 base_url="http://op") as op:
        assert (await op.get("/api/graph")).status_code == 403
        assert (await op.get("/api/graph", headers={"Tailscale-User-Login": "eve@example.com"})).status_code == 403
        r = await op.post("/api/sessions", json={"ticket_id": "pico-blink"},
                          headers={"Tailscale-User-Login": "eve@example.com"})
        assert r.status_code == 403 and not farm.world.sessions
        assert (await op.get("/api/graph", headers={"Tailscale-User-Login": "Adrian@example.com"})).status_code == 200


async def test_admin_proxy_only_forwards_c3_admin_endpoints(farm):
    assert (await farm.op.post("/api/rigs/rig-1/admin/../v1/leases", json={})).status_code == 404
    assert (await farm.op.post("/api/rigs/rig-1/admin/shell", json={})).status_code == 404
    r = await farm.op.post("/api/rigs/rig-1/admin/maintenance", json={"on": True})
    assert r.status_code == 200 and farm.stack.rigs[0].maintenance is True


async def test_public_surface_is_read_only_and_never_streams_transcripts(farm):
    for path in ("/api/sessions", "/api/graph", "/api/budget"):
        assert (await farm.pub.get(path)).status_code == 404
    assert (await farm.pub.post("/api/sessions", json={"ticket_id": "pico-blink"})).status_code in (404, 405)

    served = await serve(create_public_app(farm.ctl), bind())
    seen: list[tuple[str, dict]] = []

    async def listen():
        async with httpx.AsyncClient(timeout=None) as c, c.stream("GET", f"{served.url}/pub/events") as r:
            name = ""
            async for line in r.aiter_lines():
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    seen.append((name, json.loads(line[6:])))

    task = asyncio.create_task(listen())
    try:
        farm_id = (await farm.op.post("/api/sessions", json={"ticket_id": "pico-blink"})).json()["farm_id"]
        await farm.op.post(f"/api/sessions/{farm_id}/message", json={"text": "secret plan"})
        await eventually(lambda: any(n == "evidence" for n, _ in seen), timeout=15)
        await eventually(lambda: any(n == "session" for n, _ in seen))
    finally:
        task.cancel()
        await served.stop()
    names = {n for n, _ in seen}
    assert seen[0][0] == "graph_snapshot"
    assert "session_message" not in names and "log" not in names
    for n, d in seen:
        if n == "session":
            assert "url" not in d and "devin_session_id" not in d and d["title"] == "pico-blink"
    assert "secret plan" not in json.dumps(seen)
