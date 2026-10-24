"""Scripted stand-in for a Devin session in mock mode. It does what SKILL.md asks a real session to do,
over real HTTP: join the tailnet with its one-off key, lease (or queue for) a device, run a SHA, verify,
iterate once on a camera ✗, release, and post a structured claim. It answers operator prompts."""
from __future__ import annotations

import asyncio
import random
import re
import secrets
import time
from typing import Any

import httpx

from .cloud import MockWorld, MSession

ASSERTIONS = {
    "pico": [{"type": "led_blink", "target": "pico.led", "hz": 2.0, "duty": 0.3, "tol_pct": 10},
             {"type": "log_contains", "pattern": "READY"}],
    "unoq": [{"type": "matrix_text", "target": "unoq.matrix", "text": "DEVIN", "scroll_cols_per_s": 10,
              "tol_pct": 25}],
}


class _Stop(Exception):
    pass


def _say(s: MSession, text: str) -> None:
    s.messages.append({"event_id": secrets.token_hex(8), "message": text, "source": "devin",
                       "created_at": int(time.time())})


def _field(prompt: str, name: str) -> str | None:
    m = re.search(rf"^{name}:\s*(\S+)", prompt, re.M)
    return m.group(1) if m else None


async def _step(world: MockWorld, s: MSession, seconds: float, acu: float = 0.1) -> None:
    """Spend time like an agent would, answering operator messages meanwhile."""
    loop = asyncio.get_running_loop()
    end = loop.time() + seconds * world.speed
    while (remaining := end - loop.time()) > 0:
        try:
            text = await asyncio.wait_for(s.inbox.get(), remaining)
        except asyncio.TimeoutError:
            break
        _say(s, f"Got it: “{text}”. I'll take that into account.")
    s.acus += acu
    if s.max_acu and s.acus >= s.max_acu:
        s.status, s.status_detail = "suspended", "usage_limit_exceeded"
        _say(s, "Stopping: ACU limit reached.")
        raise _Stop


async def run_agent(world: MockWorld, s: MSession) -> None:
    try:
        await _run(world, s)
    except _Stop:
        pass
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # surface mock bugs in the session transcript instead of hiding them
        s.status, s.status_detail = "error", None
        _say(s, f"[mock agent] crashed: {exc!r}")
        return
    while not s.archived:  # finished, but still answers prompts like an idle Devin
        text = await s.inbox.get()
        _say(s, f"Got it: “{text}”. The ticket is done; the evidence is linked above.")


async def _run(world: MockWorld, s: MSession) -> None:
    farm_id = s.secrets.get("FARM_ID", "")
    dtype = _field(s.prompt, "Device type") or "pico"
    hint = _field(s.prompt, "Device hint")
    evidence_base = s.secrets.get("FARM_EVIDENCE_BASE", "")
    s.status = "claimed"
    await _step(world, s, 1.0, acu=0.0)
    s.status, s.status_detail = "running", "working"
    _say(s, "Reading the ticket and setting up the farm kit.")
    await _step(world, s, 1.5)

    try:
        node = world.join(s.secrets.get("TS_AUTHKEY", ""), f"devin-{farm_id}")
    except PermissionError as exc:
        s.status = "error"
        _say(s, f"farm-join.sh failed: {exc}")
        return
    _say(s, f"Joined the tailnet as {node.hostname}.")
    await _step(world, s, 1.0)

    async with httpx.AsyncClient(headers={"X-Mock-Node": node.hostname}, timeout=40) as http:
        target = await _choose(http, world, dtype, hint)
        if target is None:
            _say(s, f"No {dtype} device on the farm; stopping.")
            s.status_detail = "finished"
            return
        base, device = target
        lease = await _lease(world, s, http, base, device)
        if lease is None:
            return
        lease_id, token = lease
        hdr = {"X-Fencing-Token": str(token)}
        final_sha, evidence_ids, passed = "", [], False
        for attempt, sha in enumerate((f"bad{secrets.token_hex(18)}"[:40], secrets.token_hex(20))):
            final_sha = sha
            _say(s, f"Deploying {sha[:7]} to {device}.")
            r = await http.post(f"{base}/v1/leases/{lease_id}/run", headers=hdr,
                                json={"repo_url": "https://example.invalid/farm-tickets.git", "sha": sha, "path": "."})
            if r.status_code != 202:
                _say(s, f"Run rejected: {r.text}")
                return
            run_id = r.json()["run_id"]
            for _ in range(60):
                st = (await http.get(f"{base}/v1/runs/{run_id}")).json().get("state")
                if st in ("running", "failed", "stopped"):
                    break
                await _step(world, s, 0.5, acu=0.02)
            await _step(world, s, 1.0)
            r = await http.post(f"{base}/v1/leases/{lease_id}/verify", headers=hdr,
                                json={"assertions": ASSERTIONS.get(dtype, ASSERTIONS["pico"]), "duration_s": 4})
            if r.status_code != 202:
                _say(s, f"Verify rejected (lease lost?): {r.text}")
                return
            verify_id = r.json()["verify_id"]
            res: dict[str, Any] = {}
            for _ in range(10):
                res = (await http.get(f"{base}/v1/verify/{verify_id}", params={"wait": 25})).json()
                if res.get("state") == "done":
                    break
            results = res.get("results") or []
            camera = [x for x in results if not x.get("self_reported")]
            passed = bool(camera) and all(x.get("passed") for x in camera)
            eid = (res.get("evidence") or {}).get("id", "")
            evidence_ids.append(eid)
            link = f"{evidence_base}/e/{eid}" if evidence_base else f"evidence {eid}"
            detail = "; ".join(f"{x['type']} {'✓' if x.get('passed') else '✗'} {x.get('detail', '')}".strip()
                               for x in camera)
            _say(s, f"Camera verdict on {sha[:7]}: {'PASS' if passed else 'FAIL'} ({detail}). {link}")
            if passed:
                break
            if attempt == 0:
                _say(s, "My logs say READY but the camera disagrees. Fixing the timing and redeploying.")
                await _step(world, s, 2.0)
        await http.post(f"{base}/v1/leases/{lease_id}/release", headers=hdr)
        _say(s, f"Released {device}.")
    s.structured_output = {"claimed_success": passed, "final_sha": final_sha, "evidence_ids": evidence_ids,
                           "confidence": 0.9 if passed else 0.2, "notes": "mock session"}
    s.status_detail = "finished"
    _say(s, "Done. " + ("The camera confirmed the final SHA." if passed else "The camera did not confirm it."))


async def _choose(http: httpx.AsyncClient, world: MockWorld, dtype: str, hint: str | None) -> tuple[str, str] | None:
    candidates: list[tuple[int, str, str]] = []
    for base in world.rig_urls.values():
        r = await http.get(f"{base}/v1/devices")
        if r.status_code != 200:
            continue
        for d in r.json():
            if (hint and d["id"] == hint) or (not hint and d["type"] == dtype):
                rank = 0 if d["status"] == "free" else 1 + d.get("queue_depth", 0)
                candidates.append((rank, base, d["id"]))
    if not candidates:
        return None
    best = min(rank for rank, _, _ in candidates)
    _, base, device = random.choice([c for c in candidates if c[0] == best])
    return base, device


async def _lease(world: MockWorld, s: MSession, http: httpx.AsyncClient, base: str,
                 device: str) -> tuple[str, int] | None:
    r = await http.post(f"{base}/v1/leases", json={"device": device, "wait_s": 3})
    if r.status_code == 200:
        body = r.json()
        _say(s, f"Leased {device} (fencing token {body['token']}).")
        return body["lease_id"], body["token"]
    if r.status_code != 202:
        _say(s, f"Lease refused: {r.text}")
        return None
    lease_id = r.json()["lease_id"]
    _say(s, f"{device} is busy; queued at position {r.json()['position']}.")
    while True:
        await _step(world, s, 1.0, acu=0.02)
        st = (await http.get(f"{base}/v1/leases/{lease_id}")).json()
        if st.get("state") == "active":
            _say(s, f"Leased {device} after waiting (fencing token {st['token']}).")
            return lease_id, st["token"]
        if st.get("state") not in ("queued",):
            _say(s, f"Queue slot ended: {st.get('state')}.")
            return None
