# CONTRACTS v1.0-draft (single source of truth)

Replaces v0.2 (cloud broker). Owner: **Person C** (integration). Change process: open a PR that touches only this file, then announce it in the team channel. Freeze at T+1.5. All bodies are JSON; times are Unix seconds (float); IDs are strings.

Naming: rigs `rig-<n>`; devices `<type>-<n>` and **globally unique** (`pico-1`, `unoq-1`, `pico-2` on rig-2). Device types: `pico`, `unoq` (stretch: `jetson`). Sessions: `farm_id` = `s-<8 hex>` assigned by control; tailnet hostname `devin-<farm_id>`.

## C0. Tailnet

**Tags and ACL** (tailnet policy file; owner C; the human applies it):
```jsonc
{
  "tagOwners": {
    "tag:rig":           ["autogroup:admin"],
    "tag:control":       ["autogroup:admin"],
    "tag:devin-session": ["tag:control", "autogroup:admin"]
  },
  "groups": { "group:team": ["<emails>"] },
  "grants": [
    { "src": ["tag:devin-session"], "dst": ["tag:rig"],     "ip": ["tcp:8080"] },
    { "src": ["tag:control"],       "dst": ["tag:rig"],     "ip": ["tcp:8080", "tcp:8081"] },
    { "src": ["group:team"],        "dst": ["tag:rig"],     "ip": ["*"] },
    { "src": ["group:team"],        "dst": ["tag:control"], "ip": ["*"] }
  ],
  "ssh": [{ "action": "accept", "src": ["group:team"], "dst": ["tag:rig"], "users": ["farm"] }],
  "nodeAttrs": [{ "target": ["tag:control"], "attr": ["funnel"] }]
}
```
Sessions can't reach each other, control, rig SSH, or port 8081 (admin).

**Session join keys:** control mints one per session using an OAuth client (`auth_keys` scope): `reusable=false, ephemeral=true, preauthorized=true, tags=[tag:devin-session], expirySeconds=3600`. It's delivered to the session as the secret `TS_AUTHKEY`, alongside `FARM_ID`.

**Session join (`session-kit/farm-join.sh`):** install tailscale. If `sudo` and `/dev/net/tun` are available, use normal mode. Otherwise run `tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055 --socks5-server=localhost:1055 --state=mem:`, then `tailscale up --authkey=$TS_AUTHKEY --hostname=devin-$FARM_ID`, and export `FARM_PROXY=http://localhost:1055` if userspace. The `farm` CLI passes `-x $FARM_PROXY` when set.

**Ports on a rig** (bound to the rig's tailnet IP only, never 0.0.0.0):
- `:8080` session API (C1)
- `:8081` control/admin API + event stream (C3, C4)
- `127.0.0.1:8090` verifier, local only (C5)

## C1. Rig session API (`http://<rig>:8080`, owner A)

**Identity:** rigd resolves every request's source IP with `tailscale whois --json` (or LocalAPI `/localapi/v0/whois`). The holder is `{node_name, tags}`. Requests from nodes without `tag:devin-session` or `group:team` membership get 403. A lease belongs to the node that acquired it; lease-scoped calls must come from that node **and** carry `X-Fencing-Token`.

- `GET /v1/rig` → `{rig_id, online: true, model, temp_c, load1, mem_free_mb, throttled, camera_ok, verifier_online, maintenance, devices: [<device>]}`
- `GET /v1/devices` → `[<device>]`, where `<device>` = `{id, type, status: "free"|"leased"|"resetting"|"offline", holder?: node_name, queue_depth, outputs: ["pico.led", ...], describe_url}`
- `GET /v1/devices/{id}/describe` → markdown: board facts, wiring, how to write a program, gotchas, assertion examples
- `POST /v1/leases` `{device, ttl_s?: 300 (max 900), wait_s?: 20 (max 25)}`
  - 200 `{lease_id, device, token, expires_at, max_hold_until}`
  - 202 `{lease_id, queued: true, position}`. Poll `GET /v1/leases/{id}`; the queue slot is held while you poll at least every 30 s
  - 409 `device_offline` / `maintenance`
- `GET /v1/leases/{id}` → `{state: "queued"|"active"|"released"|"expired"|"revoked", position?, token?, expires_at?}`
- `POST /v1/leases/{id}/renew` → `{expires_at}`. Any lease-scoped call also renews. Hard cap 1800 s from grant.
- `POST /v1/leases/{id}/run` `{repo_url, sha, path}` → 202 `{run_id}`
- `GET /v1/runs/{run_id}` → `{state: "queued"|"fetching"|"building"|"running"|"failed"|"stopped", error?: {code, message, log_tail}, build_time_s?}`
- `GET /v1/runs/{run_id}/logs?since=<ts>` → `{lines: [{ts, text}], next}`
- `POST /v1/leases/{id}/verify` `{assertions: [<C6>], duration_s?: 10 (max 30)}` → 202 `{verify_id}`
- `GET /v1/verify/{verify_id}?wait=<s≤25>` → `{state: "pending"|"done"|"error", results?: [<C6 result>], evidence?: {id, local_url}}`. Long-polls until done or `wait`.
- `POST /v1/leases/{id}/release` → 200

**Errors:** `{error: {code, message, next}}`, where `next` is the call the agent should make. Codes: `not_on_tailnet` 403, `not_holder` 403, `stale_token` 403, `unknown` 404, `device_offline` 409, `busy` 409, `maintenance` 409, `rate_limited` 429, `lint_failed` 422, `build_failed` (run state).

## C2. Lease semantics (rigd, per device)

- Exactly one active lease per device. FIFO queue with aging. A node may hold at most 2 active leases rig-wide.
- The fencing token is a monotonic integer per device, persisted in SQLite, incremented on every grant.
- TTL 300 s, renewed by any lease-scoped call; hard cap 1800 s. Also ended when the holder's node is absent from `tailscale status` for 30 s, or on admin revoke.
- **Hand-over:** end lease → stop program → reset to idle → verifier `confirm_idle` (≤ 10 s) → grant the next waiter. If idle can't be confirmed, the device becomes `offline` with a reason and the queue stays put; the team is alerted on the map.
- On rigd start, every device is reset and idle-confirmed before any grant.
- Queued requests whose node stops polling for 30 s are dropped.

## C3. Rig control API (`http://<rig>:8081`, only `tag:control` and `group:team`, owner A)

- `GET /v1/state` → full snapshot `{rig: <C1 rig>, devices: [<device> + {lease?: {lease_id, holder, token, granted_at, expires_at}, queue: [{lease_id, holder, position, since}], last_verdict?: {verify_id, passed, at}}], camera: {ok, fps, last_frame_age_s}}`
- `GET /v1/events` → SSE (C4)
- `GET /v1/devices/{id}/snapshot.jpg` → current **cropped** ROI frame from the verifier (rate limit 1/s)
- `GET /v1/evidence/{id}` and `/v1/evidence/{id}/{file}` → evidence bundle (C7) for control to republish
- Admin (team only; rigd checks `group:team` via whois): `POST /v1/admin/maintenance {on}`, `POST /v1/admin/devices/{id}/reset`, `POST /v1/admin/leases/{id}/revoke`

## C4. Event stream (rig `:8081/v1/events`, and control re-emits at `/api/events`)

SSE events: `event: <name>`, `data: <json>`. Every payload has `rig_id`, `ts`.
- `rig_health {temp_c, load1, mem_free_mb, throttled, camera_ok, verifier_online}` every 5 s
- `device {device, status, holder?, queue_depth}`
- `lease {device, lease_id, holder, event: "queued"|"granted"|"renewed"|"released"|"expired"|"revoked", position?}`
- `run {device, run_id, state}`
- `log {device, run_id, ts, text}` (rate-capped at 20/s)
- `verify {device, verify_id, state, results?}`
- `evidence {device, evidence_id, passed}`

Control adds:
- `session {farm_id, devin_session_id, node_name?, status, acus, title, url}`
- `session_message {farm_id, source: "user"|"devin", text, ts}`
- `graph_snapshot {nodes, edges}` (on connect; see FRONTEND.md for the schema)

## C5. Verifier local API (`127.0.0.1:8090`, owner B; rigd is the only client)

- `GET /health` → `{ok, fps, last_frame_age_s, calibrated: {<device>: bool}}`
- `POST /observe` `{device, assertions, duration_s, run_id}` → `{results, evidence_dir}` (blocking; rigd wraps it as async verify)
- `POST /confirm_idle` `{device}` → `{ok, detail, measured}` (checks the C8 idle pattern)
- `POST /calibrate` `{device}` → `{ok, detail}`
- `GET /snapshot?device=<id>` → JPEG, cropped to ROI
- `GET /stream?device=<id>` → MJPEG, cropped, ≤ 10 fps
- `POST /quiet {on, max_s}` (reserved for the stretch GPU lane)

## C6. Assertions and results

```json
{"type": "led_sequence", "target": "pico.leds", "steps": [{"on": [0,2], "ms": 500}, {"on": [1], "ms": 500}], "repeat": 3, "tol_ms": 80}
{"type": "matrix_frame", "target": "unoq.matrix", "ascii": ["13 chars # or .", "... 8 rows"], "tol_cells": 2, "hold_s": 2}
{"type": "matrix_text",  "target": "unoq.matrix", "text": "DEVIN", "scroll_cols_per_s": 10, "tol_pct": 25}
{"type": "led_blink",    "target": "pico.led", "hz": 2.0, "duty": 0.3, "tol_pct": 10}
{"type": "led_state",    "target": "pico.led", "state": "on"}
{"type": "rgb_color",    "target": "unoq.rgb1", "color": "green"}
{"type": "log_contains", "pattern": "READY"}
```
- `led_sequence`: `pico.leds` is an indexed LED bank. Index 0 is the onboard LED (GP25); indices 1+ are external LEDs on fixed GPIOs listed in the Pico's describe (default GP16–GP19). Matching is step-order + per-step duration within `tol_ms` (≥ one frame period).
- `matrix_frame`: the 8×13 Uno Q matrix after homography from calibration corners; per-cell on/off; must hold for `hold_s`.
- Routing: `log_contains` is evaluated by rigd over run logs and **always returns `"self_reported": true`**; everything else goes to the verifier.

Result, one per assertion:
```json
{"type": "led_sequence", "target": "pico.leds", "passed": false,
 "measured": {"steps": [{"on": [0,2], "ms": 498}, {"on": [0,1], "ms": 503}]}, "expected": {...},
 "uncertainty": {"ms": 33}, "detail": "step 2: LED 0 still on (expected only LED 1)", "self_reported": false}
```
No pass without a measured value. If the device is not visible (uncalibrated, camera down, drift), the result is `passed: false` with the reason.

## C7. Evidence bundle (stored on the rig, republished by control)

`/var/lib/farm/evidence/<id>/` containing `evidence.json`, `clip.mp4`, `clip.gif` (< 3 MB), `frame-*.jpg`.
```json
{"evidence_id": "...", "rig_id": "rig-1", "device": "pico-1", "holder": "devin-s-1a2b3c4d", "farm_id": "s-1a2b3c4d",
 "repo_url": "...", "sha": "...", "run_id": "...", "verify_id": "...", "started_at": 0, "finished_at": 0,
 "results": [<C6 result>], "rig": {"temp_c": 0, "throttled": false}, "verifier_version": "..."}
```
Public URL (control, Funnel): `https://<control>.<tailnet>.ts.net/e/<evidence_id>`, where `evidence_id` is 128-bit random. The clip has a burned-in overlay: assertion, measured value, verdict, timestamp, "recorded by the Farm camera".

## C8. Idle patterns (verifier calibrates and confirms from these)

- `pico-1`: LED 0 blinks at 0.5 Hz; external LEDs off.
- `unoq-1`: matrix shows the four corner pixels steady plus a centre heartbeat at 0.5 Hz; RGB off.
Idle programs live in `rig/idle/<type>/`, owned by A.

## C9. Ticket format (`farm.yaml` in each ticket dir, owner D)

```yaml
device_type: pico          # pico | unoq
entry: main.py             # pico: main.py; unoq: app dir root (app.yaml, python/main.py, sketch/...)
timeout_s: 120
outputs: [pico.leds]
```
`TICKET.md` is the text the session receives (device type, not device id; "verify before claiming done"). `assertions.json` is the hidden grading spec (not in the public ticket repo). The reference solution lives in a private branch.

## C10. Control API (`farm-control`, owner C; UI owner D consumes it)

Operator port (tailnet only, `https://<control>.<tailnet>.ts.net` via `tailscale serve`; caller identity from the `Tailscale-User-Login` header, team only):
- `GET /api/graph` → `{nodes, edges}` (FRONTEND.md §3)
- `GET /api/events` → SSE: rig events (C4) merged and prefixed with `rig_id`, plus `session`, `session_message`
- `GET /api/sessions` → `[{farm_id, devin_session_id, title, status, acus, node_name, online, leases: [...], url}]`
- `GET /api/sessions/{farm_id}/messages` → `[{source, text, ts}]`
- `POST /api/sessions` `{ticket_id, device_hint?, mode?: "normal", max_acu?: 5, extra_prompt?}` → `{farm_id, devin_session_id}`. Control mints the join key and calls Devin create-session with `session_secrets` (`TS_AUTHKEY`, `FARM_ID`), `playbook_id`, `max_acu_limit`, `tags`, and optionally `structured_output_schema` (C11).
- `POST /api/sessions/{farm_id}/message` `{text}` → 200 (Devin send-message)
- `POST /api/sessions/{farm_id}/stop` → archive the session, revoke its leases on every rig, and delete its tailnet node
- `POST /api/rigs/{rig_id}/devices/{id}/poll` → `{state, snapshot_url}` (fresh health + snapshot)
- `POST /api/rigs/{rig_id}/admin/...` → proxies C3 admin
- `GET /api/budget` → `{acus_used, acus_cap, sessions_live}`

Public port (Funnel `:443`, read-only, no transcripts, no prompting): `GET /` (public map), `GET /pub/graph`, `GET /pub/events` (C4 rig events + session status without messages), `GET /e/<id>` (evidence page), `GET /e/<id>/<file>`.

**Rig discovery:** control lists peers with `tag:rig` from `tailscale status --json` every 10 s and subscribes to each rig's `/v1/events`. A rig that drops out turns grey on the map; its devices show `offline`.

**Session ↔ node mapping:** the hostname `devin-<farm_id>` links the Devin session to its tailnet node, and therefore to its leases.

## C11. Session claim (structured output, used by experiments)

```json
{"type": "object", "required": ["claimed_success", "final_sha"],
 "properties": {"claimed_success": {"type": "boolean"}, "confidence": {"type": "number"},
                "final_sha": {"type": "string"}, "evidence_ids": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"}}}
```
