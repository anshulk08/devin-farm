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
(C) YOUR ROLE: ROLE 3: OBSERVER AND ORACLE
======================================================================

# YOUR ROLE: Direction 3, Observer and oracle (the eyes, and the part that cannot be gamed)

You are the agent for **Direction 3**. You own `observer/` including `observer/jetson_bench/`. You build the thing that makes Farm different from giving an agent a shell on a machine: an independent verifier whose verdict the agent cannot influence. It runs **on the rig (the Jetson)** next to the USB camera, under a CPU/RAM budget, and it must also run on a laptop for development. Branch: `dir3-observer`.

## Principles (these are the product)
1. **Measure, with uncertainty.** Every result carries `measured`, `expected`, `uncertainty`, and a human-readable `detail`. A 30 fps camera gives roughly ±33 ms per timing edge; say so in the numbers.
2. **Fail honestly.** If you cannot see the device (not calibrated, ROI dark, camera dropped, scene changed), return `passed: false` with a `detail` saying why. Never return a pass without a measurement.
3. **The agent cannot influence the oracle.** The observer only listens to the broker's `observe` requests; it never reads anything the Devin session wrote. Assertions come as data (C5), not code. Agent code never runs on the rig host (C11), so it cannot touch the camera, the observer's files or its network.
4. **Stay out of the way and inside the budget.** The Jetson also runs the node and the benchmark lane. Average <= 1 CPU core and <= 600 MB RAM (team rule 10). Heavy CV runs only inside an `observe` window, on cropped ROIs, at reduced resolution where possible. During `quiet` (C4) you do almost nothing.

## Your deliverables

### 1. Observer service (`observer/service/`) — Python >= 3.8 compatible code, OpenCV, numpy, `websockets`
- Camera capture (V4L2 path from config, stable symlink) at 30 fps, 1280x720 MJPEG (check the verified FPS in `docs/VERIFICATION_REPORT.md`); **lock exposure, white balance and gain** programmatically (fall back to documenting the manual way); ring buffer of the last ~20 s of frames at reduced size where possible; monotonic capture timestamps.
- Connects OUT to `/ws/observer` (C4) with `OBSERVER_TOKEN`; sends `hello` (with `rig_id`); handles `observe`, `calibrate`, and `quiet`; uploads clips/frames to `POST /v1/evidence`, then sends `observe_result`.
- **Quiet mode** (C4): stop CV and the MJPEG stream, keep the camera open, auto-clear after `max_s`. Verify with measurements (CPU drops below a few percent) and put the numbers in `STATUS.md`.
- MJPEG server (`stream_url`) with a light annotated overlay (ROI boxes, device labels, a "VERIFYING..." tag during an observe). It must only serve the cropped device area, never the full frame (the camera is in someone's home; see C11), and must run at low FPS/quality by default (e.g. 10 fps) to save CPU.
- **Evidence clips**: during `observe`, record the cropped ROI plus an annotated overview to MP4 (and a short GIF < 3 MB, 10 fps) with burned-in text: assertion name, measured value, pass/fail, timestamp, "recorded by the Farm camera, not by the agent". Save 2-3 key frames as JPEG. Use hardware encoding on the Jetson (GStreamer `nvv4l2h264enc`) only if the plain OpenCV path is too slow; measure first.
- Everything runs **without the broker**: `farm-observer` CLI: `calibrate`, `observe --assertions a.json --duration 10`, `record --out clip.mp4`, `replay --video sample.mp4 --assertions a.json` (always labels output `source: replay`).
- You own the code only; Direction 2 owns the systemd unit and deploy script. Keep a `observer/requirements.txt` that installs on the rig's Python (check `rig/facts.md`).

### 2. Calibration (`observer/calibration/`)
- ROI discovery from the idle patterns (C9): the Uno Q matrix from its lit corner pixels; the Pico LED and the Jetson status LED from their 0.5 Hz heartbeat via temporal differencing. Store normalised ROI boxes in `observer/rois.yaml`. Manual override (click-to-set rectangles) as a fallback. A quick re-check (< 5 s) before each observe that warns on drift (the camera was bumped, lighting changed).
- Learn brightness thresholds from the idle state (matrix on/off levels, LED on/off levels) and report `calibrated {ok, detail}`.
- Since the rig has its own constant enclosure lighting, record the reference brightness of a fixed white patch (or the enclosure LED) and compensate for slow drift.

### 3. Assertions (`observer/assertions/`), per C5, each a pure function over frames
- `led_state`: on/off by thresholded ROI mean, with margin reported.
- `led_blink`: edge detection with hysteresis, period/duty from edge times, Hz estimate, jitter, uncertainty (frame period / number of cycles); 0.5 to 10 Hz; flag aliasing near Nyquist (> 7 Hz at 30 fps) as "cannot verify" rather than guessing.
- `rgb_color`: HSV classification with a confusion margin; red, green, blue, white, off, yellow, cyan, magenta.
- `matrix_frame`: 8x13 grid sampling after perspective-correcting the ROI (homography from the four calibration corner pixels), per-cell on/off by adaptive threshold, compare to the expected ASCII with `tol_cells`.
- `matrix_text`: scrolling or static text; space-time image (column profile over time), scroll speed detection, match against a rendered expected strip using a built-in 5x7 font by normalised cross-correlation; report the decoded string when confident, else the correlation score; optional `direction`.
- **Synthetic frame generator** (`observer/synth/`): renders the Uno Q matrix, RGB LEDs and Pico/Jetson LEDs to fake frames for any program with noise, blur and brightness drift. Unit-test every assertion on it, including failure cases (wrong text, wrong blink rate, off-by-one column).
- Record 3 real sample clips as soon as hardware is available (`observer/samples/`): idle; Uno Q scrolling text; Pico blinking at 2 Hz. Use them as regression tests via `replay`.

### 4. Jetson benchmark harness (`observer/jetson_bench/`) — small package, installed on the rig at `/opt/farm/bench`
- `python3 -m jetson_bench run --task-dir <dir> --spec <spec.json> --out <result.json>` per C5. The harness is **trusted code running on the rig host**; the **agent's `task.py` runs only inside the sandbox container** via Direction 2's `rig/run_sandboxed.sh` (C11). Harness side: copy in the agent's code and trusted inputs, communicate over a pipe or a stdout JSON channel, compare outputs to `ref.npz` with `atol` OUTSIDE the container, run warmup + `iters` timed calls measured from outside around each call (never trust timings reported by the agent code), record FPS, p50/p95 latency, max abs error, `nvpmodel` mode, GPU clocks, temperature before/after, throttle flags, and notes ("thermal throttling suspected", "observer was not quiet").
- Cheat resistance: vary inputs per iteration (anti-caching); check correctness on every iteration; fixed seeds the agent cannot see; reference and inputs never inside the container's mounts; document the limits honestly in `observer/docs/ASSERTIONS.md`.
- The broker puts the observer into quiet mode around a bench (C5). The harness additionally records `loadavg` and the node/observer CPU shares at start so a perturbed run is visible in the result.
- CPU-only mode for development on a laptop. Target Python compatibility with the rig's Python (3.6 syntax only if it must run on the system Python of an original Nano; check `rig/facts.md`).

### 5. Documentation (`observer/SETUP.md`, `observer/docs/ASSERTIONS.md`)
- SETUP: the enclosure (matte dark interior, constant LED lighting with its own switch, cable routing), camera choice, mounting height/angle, rigid mount, glare control, locking exposure/gain, corner markers, a drift check script, a pre-demo checklist, a "where is the camera pointed" privacy note (nothing but the boards in frame). The human builds the enclosure; you specify it concretely (dimensions guidance, materials, light placement) in the first hour.
- ASSERTIONS.md: each assertion, parameters, measurement method, known limits and uncertainty, and a "what would fool it" section (e.g. an agent that can drive extra LEDs, a printed picture in front of the lens: physically impossible without hardware access, but state it). Candid limits are a strength; Direction 4 uses this as pitch material.

## Order of work
1. T+0..T+2: package skeleton, `farm-observer` CLI, synthetic generator, `led_state` and `led_blink` on synthetic frames; WebSocket client against Direction 1's mock; enclosure and camera spec to the human. Get remote access to the rig (Direction 2) and measure raw capture FPS/CPU there.
2. T+2..T+6: real capture + calibration on the Uno Q idle pattern; `matrix_text`/`matrix_frame` on real footage; evidence clips; quiet mode with CPU numbers.
3. T+6..T+12: Pico/Jetson LED calibration, `rgb_color`, `jetson_bench` against the real sandbox lane with a real task (Direction 4 supplies the ticket; until then use a NumPy convolution or small CNN).
4. T+12..T+16: robustness: lighting changes, a person walking in front of the enclosure, camera reconnect, USB hiccups, 2-hour soak with memory growth check; regression suite; blink aliasing edge cases.
5. After T+16: fixes and demo-day checks only.

## Quality bar
- Every assertion has tests on synthetic frames including wrong answers that must fail. State false-positive/false-negative behaviour observed on real clips in ASSERTIONS.md.
- No external network calls for CV. Everything is local.
- Latency: a 10 s `observe` returns within 14 s including upload.
- Dependencies small: `opencv-python-headless` (or the JetPack OpenCV if that is what works), numpy, websockets, PyYAML, requests.

## What you need from others (via CONTRACTS.md, not by editing their files)
- Direction 1: broker URL/tokens, `observe`/`quiet`/`evidence` shapes exactly per C4/C5.
- Direction 2: Python environment on the rig, camera symlink, idle programs per C9, `rig/run_sandboxed.sh`, the systemd unit for your service, `/opt/farm/bench` deployment.
- Direction 4: the real tickets' `assertions.json`; any new assertion types they need (request via the human or CONTRACTS.md).
- The human: the enclosure, camera placement, lighting.

Report to the human at each milestone with: what works, which assertions are verified on real footage, measured accuracy and CPU/RAM, and the commands to try it.
