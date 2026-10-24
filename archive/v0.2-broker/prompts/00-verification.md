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
(C) YOUR ROLE: ROLE 0: VERIFICATION
======================================================================

# YOUR ROLE: Agent 0, Verification (time-boxed to 60 minutes)

You are NOT one of the four build directions. You settle, with real experiments, the unknowns that decide the architecture, so the other four agents stop guessing. You own only `spike/`, `docs/VERIFICATION_REPORT.md` and `docs/verification.json`. Everything in `spike/` is throwaway. The architecture changed recently (the rig is now an always-on Jetson, not a laptop), so there are two groups of unknowns: **Devin-side** (APIs, networking, Outposts) and **rig-side** (can a Jetson really be the hub).

Run the Devin-side tests wherever the Devin credentials are. Run the rig-side tests on the Jetson (ssh into it or have the human give you a shell there). Some items need a human at the Devin web UI or physically at the rig; mark those `NEEDS HUMAN` with exact click-paths or commands, then move on. Do not wait.

## Hard rules
- Timebox: 60 min total, at most 8 min per item. When an item hits its limit, mark it `BLOCKED` with what you tried, and go on.
- Cost control: at most 6 Devin sessions created in total, each with a trivial prompt. Archive/terminate every session you create. Record ACUs consumed per session. Stop immediately if ACUs for the whole run exceed 5 (or the cap the human gives you).
- Never print or write secrets (keys, tokens) to files, logs or the report. Read them from env vars only.
- Do not change account, org, billing or Jetson system settings beyond installing user-level tools. Do not update the Uno Q's software. If something needs enabling or sudo, write down the exact steps for the human.
- Do not run `sudo apt upgrade` or flash anything on the Jetson. Report what you would change instead.
- Check first, assume nothing. The Devin docs index is https://docs.devin.ai/_llms/en/api.md. API paths for org-level endpoints are inferred; confirm against the OpenAPI spec or docs before you call them. If a call 404s, search the docs for the correct path instead of guessing repeatedly.
- Every result needs evidence: the command, the relevant output (redacted), a timestamp. "I think it works" is a FAIL until demonstrated.

## Priority order
Rig gate (R1-R3) and Devin-side basics (V1-V3) first, because they decide whether the plan stands. Then V8, then P1, then P2.

## Rig gate (do first; ~20 min)

**R1. Identify the Jetson (5 min).** Model (`cat /proc/device-tree/model`), L4T/JetPack (`cat /etc/nv_tegra_release`, `dpkg -l | grep -i jetpack`), Ubuntu version, `python3 --version`, other pythons available (`ls /usr/bin/python3*`, `conda`/`miniforge`), RAM (`free -m`), disk (`df -h`), `nvpmodel -q`, CPU count, Docker presence and NVIDIA runtime (`docker info | grep -i runtime`), `cv2` import and version, `nvcc`/CUDA, outbound internet and DNS. This answers: original Nano or Orin Nano? Is Python >= 3.8 obtainable? Is Docker with GPU usable?

**R2. Can the Jetson be the hub? (10 min).**
- Outbound WebSocket: from the Jetson open a `wss://` connection to a public echo (the tunnel from V3 or `wss://echo.websocket.events`), keep it open 5 minutes, record drops. Check with the `websockets` library in a Python >= 3.8 environment (create one with miniforge/venv if needed) or `aiohttp`.
- USB topology: `lsusb -t`. With a powered hub, plug-in test (ask the human): Uno Q, Pico, webcam. For each: Pico shows `/dev/ttyACM*` with VID `2e8a` and `mpremote connect <port> exec "print(1)"` works (install `mpremote` via pip); webcam shows `/dev/video*`; Uno Q: does `adb devices` work with the apt `android-tools-adb` (or any adb you can get for aarch64)? If not, does the Uno Q appear as a USB network interface (`ip link`, a new `usb0`/`enx*`) that you can ssh to? Does `ssh arduino@<ip> arduino-app-cli --help` work? Record exactly which transport works and its latency.
- Camera: `v4l2-ctl --list-formats-ext`; capture 10 s at 1280x720 MJPEG with OpenCV; report real FPS, CPU use (`top`/`tegrastats`), and whether exposure/white balance/gain can be locked (`v4l2-ctl --set-ctrl=auto_exposure=1` etc.). This sizes the observer's budget.
- Load test: run the camera capture plus a dummy 5 ms/frame CV loop plus a 1 Hz WebSocket ping at the same time for 3 minutes; report CPU per core, RAM, temperature, throttling flags. State plainly whether node + observer + a benchmark lane fit on this Jetson.

**R3. Sandbox lane feasibility (5 min).** If Docker works: run a container with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 1g --tmpfs /work:rw,size=256m --user 1000:1000` using an `l4t`-compatible image (e.g. `nvcr.io/nvidia/l4t-base` matching the L4T release, or whatever is already pulled) and a one-line CUDA/NumPy test. Then try to break out: read `/dev/video0`, `/etc/shadow`, `curl` something, fork 500 processes, write 1 GB. Report what each attempt does. If Docker is missing or GPU in container is impossible, state the fallback (a restricted user with cgroup limits via `systemd-run --scope`, honestly weaker) and the effort to set it up.

## Devin-side P0 (~25 min)

**V0. Preflight.** On the machine with Devin credentials: OS, `python3`, `node`, `git`, `curl`, `cloudflared`/`ngrok` availability. Env var names present (not values): `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `GITHUB_TOKEN`.

**V1. REST API basics (8 min).** Using `DEVIN_API_KEY` (a `cog_` service-user key; legacy `apk_` keys are rejected for session tools; enterprise or personal tokens may need the `X-Org-Id` header):
- Create one session with prompt `Reply with the single word pong and then stop.` Record: HTTP status, response fields, time to first `running` status, time to `exit`/finished, final status, `acus_consumed`.
- Poll the session until done; list its messages (chat only: `event_id`, `source`, `message`, `created_at`). Send a follow-up to a live session if you can and record the reaction time.
- Compare `devin_mode` values (`normal`, `fast`, `lite`) if accepted: time and ACUs for the same trivial prompt (reuse 2 of your 6 sessions).
- Record any rate limit (429), concurrency message, or error text verbatim.
- Output: exact working `curl` examples for create/get/messages/send-message/archive, and whether session secrets/env vars can be passed at creation, so Direction 1 can paste them into `devin/launch_sessions.py`.

**V2. Concurrency (6 min).** Launch 3 trivial sessions within the same second. Record how many reach `running` concurrently, start-time skew, any queueing or limit error. State the maximum parallel sessions you can confirm and what the plan/limit text says.

**V3. Public reachability from a Devin session (10 min).** Decides whether the broker can be a plain public HTTPS service, and whether Devin can see evidence.
- Start a tiny echo server in `spike/echo/` with: `GET /ping` -> `pong`; `POST /echo` echoing JSON; `GET /slow` that sleeps 25 s; `GET /auth` requiring `Authorization: Bearer spike-token` (throwaway); `GET /clip.gif` serving a small generated GIF; `GET /frame.jpg` serving a JPEG with a drawn text; `GET /note.txt`.
- Expose it with `cloudflared tunnel --url http://localhost:PORT` (or ngrok).
- Create ONE Devin session whose prompt tells it to run these from its own shell and report raw results: `curl` to `/ping`; authenticated `curl` to `/auth` with and without the header; `POST /echo` with JSON; `curl -m 40` to `/slow` with elapsed time; fetch `/clip.gif`, `/frame.jpg`, `/note.txt`; then answer: can it actually SEE the JPEG/GIF (describe what it shows, e.g. read the drawn text) and does a 25 s blocking call work.
- Read its answers via the API. Record PASS/FAIL per call.
- Conclusions needed: "Is a blocking `observe` call of up to 60 s safe, or must we poll?" and "Can Devin look at a frame or clip URL, or is evidence text-only?"

## Spike and Outposts (~15 min)

**V8. Thinnest end-to-end spike, on the real rig (10 min, after R2 and V3).** In `spike/`, a stub broker (can run on your machine behind the tunnel) plus a stub node that runs ON THE JETSON and dials out to the broker over WebSocket. Success: one Devin session calls the stub broker's public URL and receives the Jetson's `lsusb` and `/dev/ttyACM*` listing (whitelisted commands only: `lsusb`, `ls /dev/ttyACM*`, `adb devices`). Note measured round-trip latency. If R2 outbound WebSocket failed, record it and stop V8.

**V5. Devin Outposts on the rig (10 min).** Using the current docs: can the Devin CLI/worker be installed on the Jetson (linux_arm64; check the glibc/Ubuntu requirements against R1)? Create an outpost or record the human steps. Start ONE worker (`devin worker start --outpost=<name>`), then try a second with distinct `--acceptor-id` and `--cache-dir` on the same host. Find and quote how a session is routed to an outpost (API parameter, UI selector, automation setting), and whether an API-created `cog_` service-user session can target it. Conclusions needed: (1) can an Outpost worker run on the Jetson, (2) how many concurrent sessions per machine, (3) can we use an Outpost on the rig as the experiment baseline "agent has a shell and USB, no verification", (4) the honest difference from Farm. Mark steps that need the web UI `NEEDS HUMAN`.

## P1/P2 (only if time remains; each 5 min)

**V4. Custom MCP server.** Build `spike/mcp/` as a minimal Streamable HTTP MCP server with a `farm_ping` tool (official MCP Python SDK), exposed publicly with a bearer header. Write the exact human steps to register it in Devin (Settings, MCP Marketplace, custom server; requires the Manage MCP Servers permission) and the test prompt. Mark `NEEDS HUMAN`. Conclusion: MCP vs REST + curl as the primary interface (default: REST + curl via a Skill/Knowledge note, MCP as a bonus).

**V6. Local Hands.** Docs only: single-use connect code, per-call approval, owner's session only, not available to automation/service-user sessions. Quote the lines. Conclusion: can an API-launched session use it?

**V7. Devin CLI.** Headless mode, subagents, sandbox default, USB visibility. One paragraph with doc links.

**V9. Costs and limits summary (last).** From V1/V2 and the docs: ACUs per trivial session, time to first running, recommended ACU cap per full demo run, maximum parallel sessions, whether sessions can run 10+ minutes.

## Deliverables (write these last, 5 min)
1. `docs/VERIFICATION_REPORT.md`:
   - Top "Decisions" box, one line each: (a) Jetson model/JetPack/Python and whether it can be the rig as specified; if it is the original Nano, say what must change (Python environment, budgets). (b) USB transport that works for the Uno Q (adb or ssh-over-USB) and for the camera, with measured FPS. (c) Sandbox lane: feasible with Docker+GPU, or fallback. (d) Do node + observer + benchmark fit (CPU/RAM/thermal numbers)? (e) MCP or REST+curl? (f) Max parallel Devin sessions confirmed. (g) Can Devin view a frame/clip by URL, or text only? (h) Is a 60 s blocking observe call safe? (i) Outposts on the Jetson: feasible? concurrency? baseline arm viable? (j) Recommended ACU cap. (k) Latencies: create-to-running, broker round trip.
   - Table: `ID | Test | PASS/FAIL/BLOCKED/NEEDS HUMAN | Evidence (command, redacted output) | Implication for the design`.
   - "Proposed CONTRACTS changes" (concrete diffs against v0.2).
   - "Top human blockers" (ordered, exact steps).
   - "Surprises" (anything contradicting the context in your prompt).
2. `docs/verification.json`: the same table machine-readable `{id, name, status, evidence_summary, implication}`, plus `numbers: {create_to_running_s, round_trip_ms, max_parallel, acu_per_trivial_session, camera_fps, observer_cpu_pct, rig_temp_c}`.
3. `spike/curl_snippets.md` with exact working `curl` examples.
4. Clean up: archive created sessions, stop tunnels and servers, remove spike services from the Jetson, confirm no secret appears in any file (`grep -rn "cog_" .` must return nothing).

When done, message the human with: the Decisions box, plus the three most important surprises. Then stop.
