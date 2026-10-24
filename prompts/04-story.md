You are a coding agent on a four-person hackathon team building "Devin Farm". Read this whole message before acting. It contains (A) the shared project context, (B) the interface contracts, and (C) your specific role.

How to start:
1. Read A, B and C completely. If the repo already contains `docs/CONTRACTS.md`, read it too; it overrides section B if newer.
2. Reply with a plan of at most 15 lines: what you will build first, what you will mock, what you need from other people. Ask the human only questions that block you right now; for everything else, choose a sensible default and write it in `STATUS.md`.
3. Then start working immediately, in your own directories only, following the order of work in section C. Report at each milestone.

Be critical and direct with the human: if something in this brief looks wrong, infeasible or inconsistent, say so with your reasoning instead of silently working around it.

======================================================================
(A) SHARED PROJECT CONTEXT
======================================================================

# PROJECT CONTEXT (identical for every agent on this team)

**Project: Devin Farm.** Entry for a Devin hackathon. Judged on: technical complexity, use of Devin, a working demo, design, originality.

**What it is.** A hardware lab that lives on the internet, built for *cloud* Devin sessions (and, by design, any other agent that can make HTTPS calls). The lab is a **rig**: an always-on Jetson sitting in a light-controlled enclosure at a fixed location (home or dorm), with the boards plugged into it and one USB camera watching them. No laptop is in the loop; laptops are only clients (developers, dashboard viewers).

Devices on the rig:
- `unoq-1`: Arduino Uno Q (Debian Linux on the MPU + an STM32 MCU; 8x13 blue LED matrix; 4 RGB LEDs), connected to the rig by USB only (no WiFi, see trust model).
- `pico-1`: Raspberry Pi Pico (microcontroller, no OS, so the rig programs it over USB).
- `jetson-1`: **the rig itself, as a sandboxed compute lane.** Agent code runs inside a locked-down container on the Jetson; it can use the GPU and nothing else. It is verified by a trusted benchmark harness, not the camera.

Cloud sessions get a short lease on a device, push code by git reference, the rig deploys it, and a camera-based **oracle** (the observer) that the agent cannot influence verifies what the board physically did. The answer comes back as **evidence** (assertion results with measurements, plus a video clip) that the session reads and acts on. Up to three sessions, one per device, work at the same time.

**The pitch (one sentence).** "Outposts give a Devin a shell on your machine. Farm gives any agent a lab on the internet where nothing is trusted until a camera confirms it."

**Why Farm exists next to Devin's own options. Be accurate; do not over-claim.**
- The physical topology is now close to Devin Outposts: a dedicated always-on box with peripherals. **So the physical setup is NOT the differentiator and must never be pitched as one.** What differs is the software and trust layer.
- Devin Outposts: a worker gives the session a shell on the machine; one session per machine while active; the agent can do anything on that box, including touching the camera and the verifier; no per-device scoping or independent verification documented; Pro/Max/Teams plans. (We expect to use an Outpost worker on the rig only as an experiment baseline and optionally as a sysadmin helper.)
- Local Hands: cloud VM plus a shell on your machine; human approves connections and, by default, each call; not available to automation, scheduled or service-user sessions.
- Devin CLI: a local agent, not a cloud session.
- Farm: sessions stay in normal cloud VMs and have NO shell on the rig. They call a narrow HTTPS API. Per-device lease plus fencing token; code reaches the board by git reference and runs only on the device or in the sandbox; independent camera verification that the agent cannot tamper with; reset to idle on expiry or crash; evidence attached to PRs; works for service-user, automation and scheduled sessions; harness-agnostic (plain REST).
- Running three sessions at once is NOT the differentiator either. Camera verification, hands-off operation, per-device scoping, safe recovery and the trust boundary are.

**Architecture.**
```
Devin cloud sessions --HTTPS (REST or MCP, bearer)--> BROKER (cloud, stable public URL)
                                                        ^   ^   outbound WebSockets only (rig dials out)
                                                        |   |
        +-----------------------------------------------+---+---------------+
        | RIG (Jetson, enclosure, always on, systemd services)                |
        |   farm-observer : camera + CV + clips        (trusted)              |
        |   farm-node     : drivers, leases enforcement (trusted)             |
        |   sandbox       : locked-down docker lane = device jetson-1         |
        |   USB: Uno Q (adb/ssh over USB), Pico (serial), webcam, powered hub |
        +---------------------------------------------------------------------+
Dashboard (browser) <-- SSE + MJPEG -- BROKER
Team members reach the rig remotely over Tailscale/ssh (see C12).
```
The rig dials OUT; nothing is exposed inbound. The broker stays in the cloud so the public URL survives a rig outage and shows the rig as `offline` gracefully.

**Trust boundaries (summary; full spec in C11).**
- Trusted: broker, node, observer, benchmark harness, idle programs.
- Untrusted: everything a Devin session wrote (the ticket repo contents) and everything a session sends.
- Agent code only ever runs: on the Uno Q's Linux side or MCU, on the Pico, or inside the Jetson sandbox container. NEVER on the rig host. The container has no network, no camera, no mounts except its own work dir, no Docker socket, resource limits.
- The Uno Q has no WiFi/LAN access (USB link only) so a hostile program cannot reach the owner's home network.

**Device facts worth knowing.**
- Uno Q: apps deploy with `arduino-app-cli app start <dir>` (also `app stop`, `app logs`), run on the Uno Q itself over adb or ssh (`arduino@<ip>`). App layout must be exactly: `app.yaml`, `python/main.py`, `python/requirements.txt`, `sketch/sketch.ino`, `sketch/sketch.yaml`. Python must call `App.run(user_loop=...)` or it exits. FQBN `arduino:zephyr:unoq`; library names in `sketch.yaml` must match the library manager exactly. Python and the sketch talk via `Bridge` (`Bridge.provide` in the sketch, `Bridge.call` in Python); keep callbacks short or RPC times out. First run is slow. Timing-critical work belongs on the MCU, not the Linux side. FREEZE the board's software after setup (an App Lab update has been reported to reset the password). Unverified: whether adb from an aarch64 Jetson (apt `android-tools-adb`, old version) can talk to the Uno Q; whether the Uno Q offers an ssh-over-USB network link; this is on the hour-0 verification list.
- Pico: prefer MicroPython with `mpremote` (copy `main.py`, soft reset, read serial); it avoids BOOTSEL button entry. Pico USB VID is `2e8a`.
- Jetson: **model and JetPack version are unknown; identify them first.** The original Nano (4 GB, JetPack 4.x, Ubuntu 18.04, system Python 3.6, ~4 A57 cores) is tight for node + observer + a benchmark lane at once. Orin Nano (JetPack 6, Ubuntu 22.04, Python 3.10) is comfortable. If it is the original Nano, run Farm services in a Python >= 3.8 environment (miniforge/conda or a container), not the system Python 3.6; the benchmark task environment is separate. Use `tegrastats`, `nvpmodel`, `jetson_clocks` for measurement hygiene. The Nano dev kit's USB ports share 1 A: use a powered USB hub for the camera and boards.

**Team ownership (four directions, minimal overlap).**
| # | Direction | Owns (only edit your own paths) |
|---|---|---|
| 1 | Broker and Devin side | `broker/`, `devin/`, `docs/CONTRACTS.md` |
| 2 | Node, drivers, rig provisioning | `node/` (incl. idle programs), `rig/` (systemd, sandbox image, provisioning, deploy script) |
| 3 | Observer and oracle | `observer/` (incl. `observer/jetson_bench/`, enclosure/lighting docs) |
| 4 | Tickets, dashboard, experiments, demo | `tickets/`, `dashboard/`, `experiments/`, `docs/pitch/` |
| 0 | Verification (one-off, 60 min) | `spike/`, `docs/VERIFICATION_REPORT.md`, `docs/verification.json` |

**Team rules (non-negotiable).**
1. Only edit files in your own paths. If you need something from another direction, change the contract (see below) or ask the human to relay a request; do not edit their files.
2. `docs/CONTRACTS.md` is the single source of truth for every interface. The copy pasted below is v0.2. If the repo has a newer `docs/CONTRACTS.md`, the repo wins. Changing a contract requires telling the human so the other owner is informed; never change one silently.
3. Walking skeleton first, polish later. Every component must run standalone with a mock or CLI for its neighbours, so nobody blocks on anybody, and so development works without the rig being free.
4. Secrets only via environment variables or the rig's root-only env file. Never commit keys, tokens or passwords.
5. Never execute agent-supplied code on the rig host. It runs only on a device or inside the sandbox container (C11).
6. Measure before you claim. Never present a replay or a mock as a live run; label it.
7. Commit small and often on your own branch (`dir1-broker`, `dir2-node`, `dir3-observer`, `dir4-story`) and rebase on `main`.
8. Keep a `STATUS.md` in your own directory: what works, what is mocked, what is blocked, what you need.
9. **The rig is shared and always on.** Anything that touches live devices from a developer machine goes through broker leases (use a team key), or is announced to the team first. Deploy to the rig only with `rig/deploy.sh <component>` (never edit files on the rig by hand), and never restart services during a scheduled demo window.
10. **Resource budget on the rig** (Nano-class): `farm-observer` average <= 1 CPU core and <= 600 MB RAM; `farm-node` average <= 10% of a core and <= 150 MB; leave >= 1 GB RAM free. Measure and report in `STATUS.md`.

**Milestones (T = hours since start; adapt to the real deadline).**
- T+1: rig provisioned (OS, ssh, Tailscale, services skeleton), model/JetPack/Python facts published; camera mounted.
- T+2: contracts frozen at v1.0; each component runs standalone and says hello over its interface.
- T+6: first end-to-end on ONE device (Uno Q) through the real broker URL: acquire, run, observe, release.
- T+12: all three lanes work end to end; one real oracle per device; sandbox lane passes its escape tests.
- T+16: FEATURE FREEZE. After this: rehearsal, experiments, video, bug fixes only.
- T+21: full rehearsal with 3 live Devin sessions; backup replay recorded; rig soak test (no crash for 2 hours).


======================================================================
(B) INTERFACE CONTRACTS
======================================================================

# CONTRACTS v0.2 (single source of truth: `docs/CONTRACTS.md`)

Changes from v0.1 (the laptop hub became an always-on Jetson rig): rig identity and health (C1, C3), longer renewable leases and a priority key (C1, C2), `quiet` mode so the observer stays out of the way during benchmarks (C4, C5), `jetson-1` redefined as a sandbox lane driven by trusted code (C5, C9), new C11 trust boundaries and C12 rig operations.

All times are Unix seconds (float). All bodies are JSON. IDs are strings. Device ids: `unoq-1`, `pico-1`, `jetson-1`. Device types: `unoq`, `pico`, `jetson`. Rig id: `rig-1`.

## C0. Environment variables (never commit values)
| Name | Used by | Meaning |
|---|---|---|
| `FARM_BROKER_URL` | node, observer, Devin sessions, dashboard | Public base URL of the broker, e.g. `https://farm.example.app` |
| `FARM_API_KEY` | Devin sessions to broker | Bearer token for the session-facing REST/MCP tools (normal priority) |
| `FARM_DEMO_KEY` | demo sessions | Bearer token whose requests jump the queue (priority key, broker config) |
| `FARM_ADMIN_TOKEN` | humans, `rig/` scripts | Admin endpoints (`/v1/admin/*`) |
| `NODE_TOKEN` | node to broker | Bearer token for `/ws/node` |
| `OBSERVER_TOKEN` | observer to broker | Bearer token for `/ws/observer` and `POST /v1/evidence` |
| `DEVIN_API_KEY` | `devin/` scripts | Devin service-user key (`cog_...`) |
| `GITHUB_TOKEN` | broker | For commit status / PR comments (optional) |
On the rig the node and observer read their tokens from `/etc/farm/env` (root-owned, mode 600, never in git).

## C1. Session-facing REST API (what Devin sessions call; implemented by the broker)
Auth header on every call: `Authorization: Bearer $FARM_API_KEY`. Calls that act on a lease also send `X-Fencing-Token: <int>`.

- `GET /v1/devices` returns `[{id, type, status: "free"|"leased"|"offline", queue_depth, description_md, visible_outputs: ["unoq.matrix","unoq.rgb1",...], observers: ["camera","bench"]}]`
- `GET /v1/rig` returns `{rig_id, online, since, node_online, observer_online, camera_ok, temp_c, load1, mem_free_mb, throttled, devices: [{id, status}]}`
- `GET /v1/describe?device=<id>` returns markdown: what the device is, wiring, ticket rules, gotchas, assertion examples (assembled from node-provided `describe_md`).
- `POST /v1/leases` body `{device, ttl_s (default 300, max 900), wait_s (default 60, max 120), session_id?}`. Blocks up to `wait_s`.
  - 200 `{lease_id, token, device, expires_at, max_hold_until}` when granted (`token` is the monotonic fencing token, an integer).
  - 202 `{queued: true, lease_id, position}` if still waiting after `wait_s` (poll `GET /v1/leases/{lease_id}`).
  - 409 if the device is offline (`error.code: "device_offline"`, with the reason from the rig if known).
- `GET /v1/leases/{lease_id}` returns `{state: "queued"|"active"|"released"|"expired", position?, expires_at?, token?}`
- `POST /v1/leases/{lease_id}/renew` returns `{expires_at}`. Any lease-scoped call also renews the TTL. A session may keep a device for as long as it keeps working, up to `max_hold_s` = 1800 from grant; no permanent locks.
- `POST /v1/leases/{lease_id}/run` body `{repo_url, sha, path}` returns 202 `{run_id}`. The node clones `repo_url` at `sha`, reads `<path>/farm.yaml`, builds and starts the program on the device (or the sandbox for `jetson-1`).
- `GET /v1/runs/{run_id}` returns `{state: "queued"|"building"|"running"|"failed"|"stopped", build_log_tail, started_at, build_time_s?}`
- `GET /v1/runs/{run_id}/logs?since=<ts>` returns `{lines: [{ts, text}], next}`
- `POST /v1/leases/{lease_id}/observe` body `{assertions: [<C5>...], duration_s (default 10, max 60)}`. Blocks until done (the verification report may change this to poll). Returns 200 `{results: [<C5 result>...], evidence_url, clip_url, frame_urls: []}`
- `POST /v1/leases/{lease_id}/release` returns 200. The broker tells the node to reset the device to idle.
- Errors: `{error: {code, message}}`. 401 bad auth, 403 stale/missing fencing token or lease not owned, 404 unknown id, 409 state conflict, 429 rate limit. Messages are written so an LLM knows what to call next.
- Optional MCP wrapper (Streamable HTTP) exposes the same operations as tools `farm_describe`, `farm_acquire`, `farm_run`, `farm_status`, `farm_logs`, `farm_observe`, `farm_release`, `farm_rig`.
- Admin (`FARM_ADMIN_TOKEN`): `POST /v1/admin/reset_all` (reset every device), `POST /v1/admin/maintenance {on: bool}` (stop granting new leases; existing ones finish), `GET /v1/admin/leases`.

## C2. Lease semantics (broker)
- One active lease per device (exclusive). FIFO queue with aging. Requests made with `FARM_DEMO_KEY` go to the front of the queue (never preempt an active lease).
- Fencing token: monotonic integer per device, persisted; each grant increments it.
- TTL default 300 s, renewed on any lease-scoped call, hard cap `max_hold_s` 1800. On expiry or session death: broker sends `reset` to the node, marks the lease `expired`, grants the next waiter only after the node acks the reset (20 s timeout, flagged).
- Rig or node disconnect: devices become `offline`; active leases get a 30 s grace period, then are expired. On reconnect the broker sends `reset` for every device before granting anything.
- Node must reject any command whose token is lower than the highest token it has seen for that device.

## C3. Node WebSocket (`wss://$FARM_BROKER_URL/ws/node?node_id=rig-1`, header `Authorization: Bearer $NODE_TOKEN`)
Every message: `{type, id?, ...}`.

Broker to node:
- `deploy {id, device, lease_id, token, repo_url, sha, path}`
- `stop {id, device, lease_id, token}`
- `reset {id, device, token?}` (reset to idle, always allowed)
- `bench {id, device, lease_id, token, spec}` (run the trusted benchmark in the `jetson-1` lane; see C5)
- `ping {}`

Node to broker:
- `hello {node_id, rig: {model, jetpack, python, ram_mb}, devices: [{id, type, visible_outputs: [...], describe_md, version}]}` (sent on every connect)
- `state {device, lease_id?, run_id?, state: "idle"|"deploying"|"building"|"running"|"failed"|"resetting"|"offline", detail?}`
- `log {device, lease_id?, ts, text}`
- `rig_status {ts, temp_c, load1, mem_free_mb, disk_free_mb, throttled, usb: [{id, present}]}` every 5 s
- `ack {id, ok: true|false, error?}`; `bench_result {id, ok, result|error}`
- `pong {}`

## C4. Observer WebSocket (`/ws/observer`, header `Authorization: Bearer $OBSERVER_TOKEN`)
Broker to observer:
- `observe {id, device, lease_id, run_id, assertions: [...], duration_s}`
- `calibrate {id, device}`
- `quiet {id, on: bool, max_s}`: stop CV and the MJPEG stream (keep the camera open, capture raw frames only if cheap) so a benchmark is not perturbed. The observer auto-clears quiet after `max_s` even if the broker never sends `on:false`.

Observer to broker:
- `hello {rig_id, cameras: [...], devices: [{id, calibrated: bool}], stream_url}`
- `observe_result {id, results: [...], clip_path?, frame_paths?}`. Clips and frames are uploaded first with `POST /v1/evidence` (multipart: `file`, `lease_id`, `kind`), which returns `{url}`; results then reference those URLs.
- `calibrated {id, ok, detail}`; `ack {id, ok}` (for `quiet`)
- Live view: the observer serves `GET <stream_url>` as MJPEG; the broker proxies it at `GET /v1/camera` (and per-device crops are the dashboard's job using normalised ROI boxes from `GET /v1/devices/{id}/roi`, returned as `{x, y, w, h}` in 0..1). Public viewing is read-only.

## C5. Assertions and results
Assertion (request):
```json
{"type": "matrix_text", "target": "unoq.matrix", "text": "DEVIN", "scroll_cols_per_s": 10, "tol_pct": 25}
{"type": "matrix_frame", "target": "unoq.matrix", "ascii": ["<13 chars: # or .>", "... 8 rows"], "tol_cells": 2}
{"type": "led_state",   "target": "pico.led", "state": "on"}
{"type": "led_blink",   "target": "pico.led", "hz": 2.0, "tol_pct": 10}
{"type": "rgb_color",   "target": "unoq.rgb1", "color": "green"}
{"type": "log_contains","pattern": "READY"}
{"type": "bench", "target": "jetson", "spec": {"entry": "task.py:run", "inputs": "inputs.npz", "reference": "ref.npz",
   "atol": 0.001, "warmup": 20, "iters": 200, "min_fps": 30, "max_p95_ms": 40}}
```
Routing: `matrix_*`, `led_*`, `rgb_color` go to the observer; `bench` goes to the node (which invokes `jetson_bench` against the sandbox lane); `log_contains` is evaluated by the broker over node logs.

**Bench orchestration (broker owns it):** send `quiet on` to the observer (max_s = bench timeout + 10), wait for ack, send `bench` to the node, wait for `bench_result`, send `quiet off` in a `finally`. Other camera assertions in the same observe call run before or after the bench window, never during it. The bench result includes the rig's own `temp_c` and `throttled` flags so a hot rig is reported rather than hidden.

Result (response), one per assertion:
```json
{"type": "led_blink", "target": "pico.led", "passed": false,
 "measured": {"hz": 1.1, "jitter_ms": 14}, "expected": {"hz": 2.0, "tol_pct": 10},
 "uncertainty": {"hz": 0.07}, "detail": "blink period 0.91 s; expected 0.5 s"}
```
Every measurement states its uncertainty (frame period, threshold margins). Never report a pass without a measured value.

`jetson_bench` command line (owned by the observer direction, invoked by the node):
`python3 -m jetson_bench run --task-dir <dir> --spec <spec.json> --out <result.json>`. The result JSON has `{ok, correct: bool, max_abs_err, fps, p50_ms, p95_ms, power_mode, temp_c, throttled, notes}`. The harness runs the agent's task inside the sandbox container (C11) and measures around the call from outside.

## C6. Evidence (`evidence.json`, stored by the broker, served at an unguessable public URL)
```json
{"lease_id": "...", "run_id": "...", "device": "unoq-1", "repo_url": "...", "sha": "...",
 "started_at": 0.0, "finished_at": 0.0, "build_time_s": 0.0,
 "assertions": [<C5 result>...], "clip_url": "...", "frame_urls": [], "logs_tail": ["..."],
 "rig": {"rig_id": "rig-1", "temp_c": 0.0, "throttled": false}}
```

## C7. Dashboard stream (`GET /v1/stream`, Server-Sent Events, no auth in dev, read-only token in prod)
Event names and data:
- `device_update {device, status, lease_id?, session_id?}`
- `lease_event {lease_id, device, event: "queued"|"acquired"|"renewed"|"released"|"expired"|"reclaimed", ts}`
- `run_update {run_id, device, state}`
- `log {device, ts, text}`
- `observe_result {lease_id, device, results}`
- `evidence {lease_id, device, evidence_url, clip_url}`
- `rig {temp_c, load1, mem_free_mb, throttled, online}` (every 5 s)

## C8. Ticket format (`farm.yaml` in every ticket directory)
```yaml
device_type: unoq        # unoq | pico | jetson
entry: python/main.py     # unoq: app dir root is the ticket dir; pico: main.py; jetson: task.py:run
timeout_s: 120
visible_output: unoq.matrix
default_assertions: []    # optional list of C5 assertions
```
Ticket repo: a Git repo with one directory per ticket, e.g. `unoq/scroll-devin/`, `pico/blink-pattern/`, `jetson/preproc-speed/`. Each also has `TICKET.md` (the text Devin receives), a starter, and (kept in a separate private `reference/` branch or folder not visible to Devin) a reference solution. Jetson tickets are bench-only: correctness plus speed against trusted inputs; the visible effect is the rig status LED (C9) plus the dashboard.

## C9. Idle and status patterns (the observer calibrates from these)
- `unoq-1` idle: matrix shows the four corner pixels lit steadily plus a center-pixel heartbeat at 0.5 Hz; RGB LEDs off.
- `pico-1` idle: visible LED blinks at 0.5 Hz (1 s on, 1 s off).
- `jetson-1` status LED (`jetson.led`, GPIO on the rig, **driven only by trusted node code, never by agent code**): idle 0.5 Hz heartbeat; solid on while a bench is running; three quick flashes after a completed bench. The sandbox has no GPIO access.
Idle programs for unoq and pico live in `node/idle/<type>/` and are deployed by the node on reset.

## C10. Physical layout (rig; documented in `observer/SETUP.md` and `rig/BRINGUP.md`)
- Rig: the Jetson on Ethernet (not WiFi), fixed IP or DHCP reservation, in a ventilated enclosure with its own constant LED lighting (so sunlight and room lights never change calibration), matte dark interior, camera on a rigid mount with locked exposure, all visible outputs inside the frame.
- USB: powered USB hub for Uno Q, Pico, camera; Uno Q connected by USB only, WiFi forgotten/disabled; Pico by USB.
- Power: Jetson on its barrel supply (J48 jumper if applicable); a smart plug or switchable relay for the hub so the team can remotely power-cycle boards.
- Watchdog: systemd services with `Restart=always`; hardware watchdog or a cron health check; the broker marks the rig offline when heartbeats stop.

## C11. Trust boundaries and the sandbox (`rig/`, owned by Direction 2; checked by Direction 1's tests and the verification agent)
Trusted components: broker, `farm-node`, `farm-observer`, `jetson_bench`, idle programs, `rig/` scripts. Untrusted: every byte from a ticket repo and from a Devin session.
- Agent code never runs on the rig host. Allowed destinations: Uno Q (Linux side and MCU), Pico, the sandbox container.
- Sandbox container (`farm-sandbox`): non-root user, read-only root filesystem, a single writable tmpfs work dir, mount only the work dir (no `/dev/video*`, no `/dev/gpiochip*`, no USB, no Docker socket, no `/opt/farm`, no `/etc/farm`), `--network none`, `--pids-limit`, memory and CPU limits, `--cap-drop ALL`, `no-new-privileges`, GPU only through the NVIDIA runtime, wall-clock timeout enforced by the node. Documented honestly as hackathon-grade isolation (shared kernel), with the escape tests in `rig/tests/sandbox/` (try to read the camera, read `/etc/farm/env`, open the network, fork-bomb, fill the disk, write outside the work dir) all expected to fail.
- Inputs and references for the benchmark live outside the container; the harness copies in only the agent's code and the inputs, and reads outputs from a pipe.
- Uno Q: no network egress beyond the USB link; `requirements.txt` is checked against an allowlist of pre-installed wheels; deploys never run `pip install` from the internet.
- Public surface: only the broker. The rig has no inbound port. The dashboard and camera stream are read-only; the public camera view is cropped to the device area and never shows the room.

## C12. Rig operations (owned by Direction 2; everyone follows)
- Paths: `/opt/farm/{node,observer,bench,sandbox}`, config in `/etc/farm/`, logs via `journalctl -u farm-node -u farm-observer`.
- Services: `farm-node.service`, `farm-observer.service`, `farm-sandbox-image` (built by `rig/build_sandbox.sh`).
- Remote access: Tailscale (or a reverse SSH tunnel) with each team member's key; no password ssh. Hostname `rig-1`.
- Deploy: `rig/deploy.sh node|observer|bench|all [--ref <git ref>]` pulls the ref on the rig, restarts the service, runs a smoke test, and rolls back on failure. Never edit files on the rig by hand.
- Maintenance windows: before a rehearsal or demo, set the broker to `maintenance` (C1 admin) and wait for leases to drain; no deploys during a demo.
- Health: `GET /v1/rig` (C1) and the `rig` SSE event (C7).


======================================================================
(C) YOUR ROLE: ROLE 4: TICKETS, DASHBOARD, EXPERIMENTS, DEMO
======================================================================

# YOUR ROLE: Direction 4, Tickets, dashboard, experiments and demo (the story)

You are the agent for **Direction 4**. You own `tickets/`, `dashboard/`, `experiments/` and `docs/pitch/`. You build everything a judge sees and everything that proves the claim: the tasks the Devin sessions work on, the live dashboard, the experiments with real numbers, and the demo. You depend on the other three for live behaviour, so you build against mocks first. You can work fully remotely: the rig is always on and reachable through the broker. Branch: `dir4-story`.

## The claim you must be able to prove
"Agents that can reach hardware still claim success when the hardware disagrees. An independent camera catches it. Farm lets several sessions use one rig safely at the same time." Judges score technical complexity, use of Devin, a working demo, design, originality. You own the last three most directly. A boring but honest chart with real numbers beats a flashy mock.

## Your deliverables

### 1. Tickets (`tickets/`, can be its own repo `farm-tickets`)
One directory per ticket: `TICKET.md` (the exact text a Devin session receives), a starter, `farm.yaml` (C8), `assertions.json` (C5), and a reference solution kept out of Devin's view (separate `reference/` folder in a private branch or repo; the session only gets the public repo). Tickets must be achievable within one session in ~10-15 minutes and visibly physical.
- **Uno Q** (camera-verified): `scroll-devin` (scroll DEVIN across the 8x13 matrix at a given speed), `pulse-rgb` (cycle the RGB LED red/green/blue at 1 Hz). Plus a clearly-labelled **trap variant** where the natural implementation fails physically but passes a log check (e.g. a timing requirement the Linux side cannot meet, so the speed must come from the MCU; or a library whose API silently ignores a call).
- **Pico** (camera-verified): `blink-pattern` (blink the LED at 2 Hz with a 30% duty cycle), plus a trap variant (LED polarity or pin number that differs from the common tutorial).
- **Jetson lane** (bench-verified, status LED shows busy): `preproc-speed` (a NumPy/GPU image preprocessing function that must match a reference within tolerance and exceed an FPS target; the starter is slow and correct, the trap is a fast version that is subtly wrong).
Rules: the ticket tells the agent which device, the API base URL and that evidence is required; it does NOT leak assertions or the reference. Confirm with Direction 2 (Uno Q libraries, Pico MicroPython features, Jetson container contents) that every ticket is solvable, by running the reference through `validate_reference.py`.
- `tickets/validate_reference.py`: runs a ticket's reference solution through the real stack with the team key (acquire, run, observe, release) and prints PASS/FAIL per assertion. This is the stack's end-to-end test without Devin; run it before every rehearsal. Also run the **trap** starters to confirm they FAIL the camera while a naive log check passes (that proves the oracle adds value).

### 2. Dashboard (`dashboard/`) — React + Vite + TypeScript, deploys as static files, consumes the broker's SSE (C7) and MJPEG
It is the demo's centrepiece, so design matters (use the frontend-design skill's principles: a distinct visual identity, not a default template; dark "control room" theme, high contrast, legible from a video).
- **Farm Floor**: three device cards laid out like the physical rig, each with live status (free/leased/offline), the session holding it, a cropped live camera tile (ROI from `GET /v1/devices/{id}/roi` applied to the MJPEG), and the current run state.
- **Timeline** (lease Gantt over the last 30 minutes) and a **queue** panel.
- **Assertions panel**: per assertion the expected vs measured value with uncertainty, pass/fail, and a "claimed vs confirmed" banner when a session reports success while an assertion fails.
- **Evidence gallery**: clips/GIFs and key frames from `evidence` events; one click opens `evidence.json`.
- **Rig health strip**: temperature, load, memory, throttling, camera OK, node/observer online (C7 `rig` event). A rig that is hot or offline should be visible and explained, not hidden.
- **Mock mode** (`?mock=1`) that replays a recorded event stream so you can develop without the rig and so the demo has a clearly-labelled replay fallback. Real data and replay must be visually distinguishable ("REPLAY" badge).
- A read-only public variant (viewer token, no admin controls), cropped camera only, so a Devpost link can show the rig live. Coordinate the token with Direction 1.

### 3. Experiments (`experiments/`) — real numbers, pre-registered
Write `experiments/PLAN.md` BEFORE running anything: hypotheses, tickets, reps, arms, metrics, how results are graded, what would falsify the claim.
- **E1: claim vs reality.** Tickets (incl. trap variants) x arms x 3 reps. Arms: `nofarm` (code only, no hardware; the session says whether it believes it works), `farm` (full tools), and `outpost` (a session with a shell on the rig and no verification) ONLY if Direction 1 and the verification report say it is feasible. Metric: percentage of sessions that claim success, versus percentage independently confirmed by the camera/bench, plus time to success, ACUs, number of iterations. `experiments/grade.py` is the **independent grader**: it takes each session's final branch/PR and runs it through the real stack with the team key and the ticket's `assertions.json`. The grader never trusts the session's own report. Report false-claim rate with an honest confidence statement (small n).
- **E2: duty cycle.** Per session, how much wall-clock time the hardware is actually in use (acquire to release, run, observe) versus Devin thinking/editing. This quantifies why per-call leases beat holding a machine for the whole session. Pure logs analysis from `runs/` and broker data.
- **E3: concurrency model** (simulation from E2 traces): N sessions on 1 rig with session-held vs per-call leases: queue wait, utilisation. Be explicit that it is a model.
- All plots/tables generated by scripts from raw JSON in `experiments/results/` with the raw data committed. Label every replay as a replay.

### 4. Demo and pitch (`docs/pitch/`)
- `docs/pitch/STORYBOARD.md`: a 2:30-3:00 video, shot by shot, with exact on-screen text. Suggested arc: (1) 15 s hook: an agent says "done, the LED blinks at 2 Hz" while the camera shows it blinking at 1 Hz: claim vs reality; (2) the rig: a Jetson in a box in someone's room, three boards, one camera, always on, nothing running in front of it but a service; (3) three Devin sessions start, three boards come alive at once, the dashboard shows leases, camera tiles and assertions; (4) one session fails an assertion, reads the measurement, fixes its code, passes; (5) PR with the evidence clip; (6) numbers from E1/E2; (7) "what Farm is not" and honest limits; (8) close.
- `docs/pitch/SCRIPT.md` (voiceover), `README.md` for the repo, Devpost text, and a **one-page architecture diagram** (SVG) that shows the trust boundary: the session has no shell on the rig.
- A **"why not just Outposts?" answer** (30 seconds, honest): the rig topology is similar; what differs is that the agent has no shell on the rig, an independent camera verifies, devices are leased individually with fencing and safe reset, it works for service-user/automation sessions, and any agent harness can use it. Use the verification report's findings about Outposts; do not claim anything it did not confirm.
- **Demo-day plan**: a live path (3 real sessions) and a backup path (recorded replay, clearly labelled), a 10-minute rehearsal script, what to do if the rig drops (maintenance toggle, replay), a checklist the human can run through. Record the backup video of a clean run at T+21.
- Be candid on limits (camera resolution, trust assumptions, hackathon-grade sandbox). Judges respond well to honest scope.

## Order of work
1. T+0..T+2: ticket drafts (just the text and the assertions), dashboard skeleton in mock mode consuming a fixture SSE stream that follows C7 exactly, `experiments/PLAN.md`. Ask Direction 2 what the boards can actually do before finalising tickets.
2. T+2..T+6: dashboard against Direction 1's mock broker; first two tickets (one Uno Q, one Pico) validated with `validate_reference.py` as soon as a real end-to-end exists.
3. T+6..T+12: all tickets + traps validated; dashboard finished against the live broker; run a first E1 pilot (1 rep) with `devin/launch_sessions.py` (Direction 1); fix ticket wording based on where sessions got confused.
4. T+12..T+16: full E1 (3 reps), E2/E3 analyses, storyboard and script done, public read-only dashboard.
5. T+16..T+21: freeze. Rehearse the live path twice, record the backup, produce final charts, polish the README and Devpost text. No new features.

## Quality bar
- The dashboard works with zero backend (mock) and with the real broker; it handles disconnects (shows "reconnecting", never a blank screen).
- Every number in the pitch traces to a raw file in `experiments/results/` and a script.
- Never present a replay or a simulation as a live measurement.

## What you need from others (via CONTRACTS.md, not by editing their files)
- Direction 1: SSE event shapes, a team API key and a read-only viewer token, `devin/launch_sessions.py` usage, ticket JSON shape.
- Direction 2: what each device can really do; which libraries exist; timings; the Jetson container contents.
- Direction 3: `observer/docs/ASSERTIONS.md` (limits and uncertainties for the pitch), ROI endpoint, the sample clips for the mock dashboard.
- The human: filming, a screen recording setup, running the live demo.

Report to the human at each milestone with: what works, what is mocked, what is blocked, and what you need.
