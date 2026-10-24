# Lane C status (control/, session-kit/, tailnet/, experiments/)

Updated 2026-10-24. Milestone: T+4 mock-first skeleton.

## Works (against mocks)
- `farm-control serve --mock` runs the whole loop with no hardware and no credentials: 2 mock rigs (F9), a mock Devin API v3, and a mock Tailscale API v2. Control uses its real HTTP clients against them.
- Rig discovery by `tag:rig`; per-rig `/v1/state` mirror and `/v1/events` subscription with reconnect/backoff. When a rig goes offline its devices show `offline` and a new `graph_snapshot` is sent.
- Graph per FRONTEND §3: lease and queue edges keyed to `devin-<farm_id>` holders; holders control didn't create show as `external`.
- Merged SSE `/api/events`, and public `/pub/events` with no transcripts or logs.
- Sessions:
  - Create mints a one-off ephemeral tagged key, then calls Devin with `session_secrets` (`TS_AUTHKEY`, `FARM_ID`, `FARM_EVIDENCE_BASE`), `playbook_id`, `max_acu_limit`, `tags` and the C11 schema.
  - Status and messages are polled every 5 s, de-duplicated by `event_id`.
  - Operator prompts reach the session.
  - Stop archives the session, revokes its leases and queue slots on every rig, and deletes its tailnet node.
- ACU guard: a live session counts at its cap, a finished one at actual spend; requests past the cap get 409 before any key is minted.
- Poll proxy, snapshot proxy (≤ 1 rig fetch per second), admin proxy (C3 paths only).
- Evidence copied off the rig on the `evidence` event and served at `/e/<id>` with an OpenGraph card. Self-reported checks are never shown as confirmed.
- Event recorder (`var/events-YYYYMMDD.ndjson`), `farm-control record`, `farm-control doctor`.
- `session-kit/`:
  - `farm-join.sh` (kernel or userspace mode, idempotent, writes `~/.farm/env`)
  - `farm` CLI over C1 (fencing tokens handled; verify exits 0 only on camera-confirmed passes)
  - `SKILL.md`, `claim.schema.json`, and `register_playbook.sh` (create, or update with `PUT`)
- `tailnet/`: `policy.hujson` (C0 plus policy tests), `acl_check.sh`, `README.md` (OAuth client, tags).
- Tests: `cd control && pytest -q` runs 30 tests: graph, parsers, bind policy, client paths, key shape, plus end-to-end against the mock stack (lifecycle, budget, prompts, stop, evidence, operator auth, public surface).

## Mocked
- Rigs (`farm_control/mock/rig.py`, C1+C3 on one port, identity via `X-Mock-Node`). Lane A's `rigd --mock-drivers --mock-identity` replaces it in `ci/e2e_mock.sh`.
- Devin and Tailscale APIs (`farm_control/mock/cloud.py`), plus the scripted session (`mock/agent.py`).
- Tickets: `farm_control/mock/tickets/` is used in mock mode unless `FARM_TICKETS_DIR` is set.

## Blocked (needs credentials or a human)
- Day-0 G1–G4, G8, G9 haven't run. They need `DEVIN_API_KEY`, `DEVIN_ORG_ID`, a Tailscale OAuth client (`TS_OAUTH_CLIENT_ID/SECRET`, scopes `auth_keys` + `devices:core`, tag `tag:devin-session`), and the policy applied with real `group:team` emails.
- `farm-join.sh` has only run against stubbed `tailscale`/`tailscaled` binaries; it needs a real Devin VM (G1/G2).
- The policy tests in `policy.hujson` run only when the policy is saved in the admin console.

## Not started
- GitHub PR comment (F17, Should), and `experiments/` (E1/E2, launcher, `grade.py`). Both come after the first real session.

## Needs from other lanes
- A: rigd C1/C3 including `--mock-identity`. Rigd must also **accept admin calls from `tag:control`** (see below).
- D: `web/dist` and `web/dist-public` builds. Control serves both. The UI should treat a repeated `graph_snapshot` as a reset and build thumbnail URLs from `data.snapshot_path`.

## Proposed CONTRACTS changes (to go in a separate contract PR)
1. **C3 admin identity:** C3 allows admin only from `group:team`. But C10 has control (a `tag:control` node) revoke leases on stop and proxy admin. Proposal: rigd also accepts `tag:control`; control authenticates the operator and forwards `X-Farm-Operator` for audit.
2. **Operator port:** Funnel takes :443, so the operator UI is served at `:8443` (`tailscale serve --https=8443`). Write that into C10.
3. **Thumbnails:** FRONTEND §6 shows live thumbnails on the public map, so control adds `GET /pub/rigs/{rig}/devices/{id}/snapshot.jpg` and `GET /api/rigs/{rig}/devices/{id}/snapshot.jpg` (shared 1 s cache).
4. **Additive fields:** `GET /api/tickets`; `mode` on the graph; `online` and `ticket_id` on `session` events; `acus_committed` on `/api/budget`; `rig` and `camera` in the poll response; `graph_snapshot` re-sent on structural changes.
5. **C7:** `evidence.json` should list its files (`files: [...]`). Until then control probes `clip.gif`, `clip.mp4`, `frame-0..11.jpg`.
6. **C2 vs SKILL:** C2 allows 2 active leases per node; SKILL/CLI allow 1. Also, `GET /v1/leases/{id}` doesn't return `device`, release has no body, and C1 doesn't say whether read-only run/verify calls need `X-Fencing-Token`.
7. **`FARM_EVIDENCE_BASE`:** delivered as a non-sensitive session secret. Add it to C0/C10.
8. **Devin:** playbooks are becoming Skills (new accounts from 2026-10-24). `playbook_id` and the Playbooks API keep working. `structured_output_required` is left at its default (true).
