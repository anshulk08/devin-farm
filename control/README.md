# farm-control

The control plane (Lane C, CONTRACTS C10). It discovers every `tag:rig` peer and mirrors each rig's C3 state and C4 events into one bubble-map graph. It drives Devin sessions through the API: create, poll, prompt, stop. It also mints per-session tailnet join keys, enforces the ACU budget, records events for replay, and republishes evidence on the public port.

```sh
cd control
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -e '.[dev]'   # or: pip install -r requirements-dev.txt
.venv/bin/farm-control serve --mock      # no hardware, no credentials
.venv/bin/pytest -q
```

## Mock mode (for Lane D and local work)

`farm-control serve --mock` starts the full stack on 127.0.0.1:
- two mock rigs: `rig-1` (pico-1, unoq-1) and `rig-2` (pico-2);
- a mock Devin API v3 and a mock Tailscale API v2;
- control itself, talking to all of them over HTTP with the same clients it uses live.

Every mock Devin session runs a scripted agent. The agent joins the mock tailnet with its one-off key, then leases a device or queues for it. It deploys a "bad" SHA, gets a camera ✗, redeploys, and gets a ✓. Then it releases the device, posts a C11 claim, and answers prompts. Create three `pico-blink` sessions to see a queue and a hand-over. `/api/graph` and `graph_snapshot` carry `"mode": "mock"`, so the UI can show its MOCK badge.

| Port | What |
|---|---|
| `127.0.0.1:8700` | operator API + operator web build (`web/dist`) |
| `127.0.0.1:8701` | public API + public web build (`web/dist-public`) |

Mock mode turns off the operator login check (`FARM_OPERATOR_AUTH=open` is refused outside mock mode). It keeps its state in `control/var/mock/`.

## HTTP surface

Operator (team only; behind `tailscale serve`; identity comes from `Tailscale-User-Login`, checked against `FARM_TEAM_LOGINS`):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/graph` | `{nodes, edges, mode}` (FRONTEND §3) |
| GET | `/api/events` | SSE. Sends `graph_snapshot` first, then C4 rig events (with `rig_id`), `session`, `session_message`. `graph_snapshot` is sent again on structural changes (rig up/down, session created/stopped), and the client should replace its graph when it arrives |
| GET | `/api/sessions` | includes `online`, `leases` (active + queued), `structured_output` |
| GET | `/api/sessions/{farm_id}/messages` | `[{source, text, ts}]` |
| POST | `/api/sessions` | `{ticket_id, device_hint?, mode?, max_acu?, extra_prompt?}` → `{farm_id, devin_session_id}`; 409 `budget_exceeded` |
| POST | `/api/sessions/{farm_id}/message` | `{text}` |
| POST | `/api/sessions/{farm_id}/stop` | archive + revoke every lease/queue slot + delete the tailnet node; returns per-step results |
| POST | `/api/rigs/{rig}/devices/{id}/poll` | fresh rig state → `{state, rig, camera, snapshot_url}` |
| GET | `/api/rigs/{rig}/devices/{id}/snapshot.jpg` | cropped ROI frame, fetched from the rig at most once a second |
| POST | `/api/rigs/{rig}/admin/{maintenance\|devices/{id}/reset\|leases/{id}/revoke}` | proxies C3 admin and adds `X-Farm-Operator` |
| GET | `/api/budget` | `{acus_used, acus_cap, sessions_live, acus_committed}` |
| GET | `/api/tickets` | `[{ticket_id, title, device_type, outputs}]` for the New-session modal |
| GET | `/e/{id}`, `/e/{id}/{file}` | evidence (same as public) |

Public (Funnel, read-only): `GET /pub/graph`, `GET /pub/events` (no `session_message`, no `log`, sessions reduced to ticket + status), `GET /pub/rigs/{rig}/devices/{id}/snapshot.jpg`, `GET /e/{id}` (evidence page with OpenGraph card), `GET /e/{id}/{file}`.

Device nodes carry `data.snapshot_path` (`rigs/<rig>/devices/<id>/snapshot.jpg`). Prefix it with `/api/` on the operator UI or `/pub/` on the public one.

## Live deployment (control node, `tag:control`)

```sh
sudo tailscale up --advertise-tags=tag:control
export FARM_TEAM_LOGINS=alice@example.com,bob@github FARM_PUBLIC_URL=https://<control>.<tailnet>.ts.net
export DEVIN_API_KEY=... DEVIN_ORG_ID=... FARM_PLAYBOOK_ID=...            # session-kit/register_playbook.sh
export TS_OAUTH_CLIENT_ID=... TS_OAUTH_CLIENT_SECRET=...                  # tailnet/README.md
farm-control doctor
farm-control serve
tailscale serve  --bg --https=8443 http://127.0.0.1:8700   # operator, tailnet only
tailscale funnel --bg --https=443  http://127.0.0.1:8701   # public, internet
```

Both servers bind 127.0.0.1 only. `tailscale serve` and `funnel` are the only way in. Funnel takes :443, so the operator UI is at `https://<control>.<tailnet>.ts.net:8443`.

| Env | Default | Meaning |
|---|---|---|
| `FARM_TEAM_LOGINS` | (empty: everyone refused) | comma-separated Tailscale logins allowed on the operator API |
| `FARM_PUBLIC_URL` | | absolute base for evidence links and OpenGraph tags; also passed to sessions as `FARM_EVIDENCE_BASE` |
| `FARM_ACU_CAP` / `FARM_MAX_ACU_DEFAULT` | 50 / 5 | global budget. A live session counts at its own cap; a finished or archived one counts at what it actually spent |
| `FARM_TICKETS_DIR` | `tickets/` | ticket root (`farm.yaml` + `TICKET.md`; `assertions.json` and `reference/` are never read) |
| `FARM_TICKETS_REPO` | | passed to Devin as `repos` |
| `FARM_KIT_REPO` | this repo | the session clones `session-kit/` from here |
| `FARM_PLAYBOOK_ID` | | passed as `playbook_id` (playbooks run as Skills on migrated Devin accounts) |
| `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_API_BASE` | | Devin API v3 |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET`, `TS_API_BASE`, `TS_TAILNET` | | Tailscale OAuth client (`auth_keys`, `devices:core`) |
| `FARM_RIG_CONTROL_PORT` | 8081 | rig C3 port |
| `FARM_OPERATOR_HOST/PORT`, `FARM_PUBLIC_HOST/PORT` | 127.0.0.1:8700 / :8701 | loopback or tailnet IP only; anything else is refused |
| `FARM_VAR_DIR` | `control/var` | `control.db` (sessions, evidence index), `events-YYYYMMDD.ndjson`, `evidence/` |

## Other commands

- `farm-control record --out run.ndjson [--url http://127.0.0.1:8700/api/events] [--login you@example.com] [--duration 600]` appends the event stream as `{"ts", "event", "data"}` lines, the same format as `var/events-*.ndjson`. Use it for replays.
- `farm-control doctor` checks config, `tailscale status`, every rig's `/v1/state`, Devin API access, the Tailscale OAuth client, tickets, the claim schema, and the web builds. It exits non-zero on any FAIL and never mints keys or creates sessions.

## Layout

`farm_control/`: `config` (env), `tailnet` (peers, Tailscale API), `rigs` (C3 client, discovery, event mirroring), `graph`, `devin` (API v3 client), `sessions` (lifecycle, budget, polling), `evidence` (republish + page), `app` (operator and public apps), `cli`, `mock/` (mock rigs, mock cloud, scripted agent, mock tickets).
