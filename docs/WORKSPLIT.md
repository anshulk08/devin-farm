# Work split: four people, four lanes

Each lane owns its directories outright. Interfaces cross lanes only through `docs/CONTRACTS.md` (owner C). Each brief below is self-contained: paste it into that person's coding agent together with `docs/SCOPE.md` and `docs/CONTRACTS.md`.

| Lane | Person | Owns | Physically at the rig? |
|---|---|---|---|
| **A: Rig & hardware** | A | `rig/` (rigd, drivers, idle programs, provisioning, systemd, USB hardening), `tickets/` | Yes |
| **B: Verifier & camera** | B | `verifier/`, enclosure/lighting spec, ticket `assertions.json` review | Yes |
| **C: Tailnet, control plane & Devin** | C | `tailnet/` (ACL policy, key minting), `control/` (backend), `session-kit/`, `experiments/`, `docs/CONTRACTS.md` | No |
| **D: Frontend, story & submission** | D | `web/`, `docs/pitch/`, `docs/media/`, `README.md`, `docs/SUBMISSION.md` | No (needs the rig for filming) |

**Shared touch points (contract only):**
- A↔B: verifier local API (C5) and idle patterns (C8)
- A↔C: rig session/control APIs (C1–C4)
- C↔D: control API + events (C10, C4) and graph schema (FRONTEND §3)
- A↔B↔C: tickets (C9) and assertions (C6)

**Team rules:**
1. Edit only your own paths. Need a change elsewhere? Open a contract PR or ask the owner.
2. Walking skeleton first: every component runs standalone with a mock of its neighbours by T+4.
3. Secrets live only in env or `/etc/farm/env` (root 600): `TS_OAUTH_CLIENT_ID/SECRET`, `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `GITHUB_TOKEN`. Never commit them.
4. Agent code never runs on the Jetson host.
5. Never present a mock or replay as live.
6. Branch per lane (`lane-a-rig`, `lane-b-verifier`, `lane-c-control`, `lane-d-web`); small PRs to `main`; `main` stays runnable.
7. Each lane keeps `STATUS.md` in its root dir: works / mocked / blocked / needs.

---

## Lane A: Rig & hardware (`rig/`, `tickets/`)

**Goal:** turn the Jetson into a rig that safely shares multiple boards among multiple tailnet sessions.

**Build:**
1. **Day-0 (G5–G7):** identify the Jetson (model, JetPack, Python, RAM, Docker); prove the Uno Q transport (adb vs ssh-over-USB), Pico `mpremote`, and `tailscale whois` on a peer IP. Check MicroPython USB-device support on our Pico firmware and the Uno Q app privilege level. Publish `rig/facts.md` by T+1.
2. **Provisioning** (`rig/provision.sh`, idempotent, the human runs it with sudo): user `farm`; Python ≥ 3.10 env for services; Tailscale with `--advertise-tags=tag:rig --hostname=rig-1 --ssh`; udev symlinks (`/dev/farm/pico-1`, `/dev/farm/unoq-1`, `/dev/farm/cam0`); **usbguard** allowlist (VID:PID + interface class per port) and `usbhid` blacklist; `/etc/farm/env`; systemd units `farm-rigd`, `farm-verifier` (B's code, A's unit) with `Restart=always`, `MemoryMax`, `CPUQuota`.
3. **`farm-rigd`** (Python, FastAPI + uvicorn, SQLite WAL):
   - Binds the tailnet IP on `:8080` (C1) and `:8081` (C3).
   - Caller identity via whois (cached 30 s).
   - Leases: exclusive per device, FIFO queue, fencing tokens persisted, TTL/renew/cap, holder-offline detection via `tailscale status --json`.
   - Hand-over: reset → `verifier.confirm_idle` → grant.
   - Deploy by git SHA: shallow clone with hooks disabled, no submodules/LFS, path/size/symlink validation, then copy to the board.
   - Runs, logs (rate-capped), async verify wrapping the verifier, `log_contains` (flagged self-reported), evidence bundle assembly (C7), SSE events (C4), admin endpoints.
   - Startup resets every device.
   - Error messages carry `next`.
4. **Drivers** (`rig/drivers/`): `Driver` ABC with `discover, deploy, stop, reset_to_idle, health, tail_logs, describe_md, outputs`. Devices come from `rig/config.yaml` (multiple boards per rig, multiple of the same type).
   - **pico:** mpremote copy, soft reset, serial tail. Reset wipes the FS (incl. `boot.py`) and installs idle. LED bank wiring: GP25 + GP16–19 with resistors, documented.
   - **unoq:** copy app to `~/ArduinoApps/<lease>`, `arduino-app-cli app start`, `app logs`. Reset stops all apps, kills user processes, wipes non-idle apps, restores the default app, starts idle. Preflight linter (layout, `App.run(`, libraries allowlist, no internet pip).
5. **Idle programs** (`rig/idle/`) per C8.
6. **Mock mode:** `farm-rigd --mock-drivers --mock-verifier` simulates boards so C and D can develop with no hardware, and so we can run a second "rig-2" on any laptop to prove multi-rig.
7. **Tests:** unit tests for leases/queue/fencing/hand-over/races (two acquirers, expiry mid-run, stale token after re-grant, holder offline, restart mid-lease), path validation, clone safety. Hardware scripts in `rig/tests/hw/`. Security checks in `rig/tests/security/`: a Pico `main.py` trying to enumerate as HID is blocked; a session node can't reach :8081, :22, or :8090.
8. **Tickets** (`tickets/`, C9), each solvable in ~10–15 min, validated with `tickets/validate.py` (acquire → run reference → verify → release via the real API):
   - `pico/led-sequence`, plus a **trap** variant (external LEDs wired active-low / non-tutorial pins);
   - `unoq/matrix-heart` (static image), `unoq/scroll-devin`, plus a **trap** (timing that only the MCU can meet, so a Linux-side loop "works" in logs but stutters on camera).
   - B reviews every `assertions.json`.

**Acceptance:** two sessions hold `pico-1` and `unoq-1` at the same time while a third waits at `#1`. On release, the board resets, idle is camera-confirmed, and the queued session is granted, all visible in `/v1/events`. `rig/health.sh` passes. Budgets measured in `STATUS.md`.

**Milestones:** T+1 facts + tailnet; T+4 rigd with mock drivers; T+8 Pico end to end with the real verifier; T+12 Uno Q + queue/hand-over + security tests; T+16 freeze; T+16–21 soak 2 h, `rig/DEMO_CHECKLIST.md`.

---

## Lane B: Verifier & camera (`verifier/`)

**Goal:** an independent oracle that measures what each board physically did, with uncertainty, under the Jetson's resource budget.

**Build:**
1. **Day-0 (G6):** camera formats/FPS at 1280×720 MJPEG, exposure/WB/gain lock via `v4l2-ctl`, CPU cost on the Jetson. Specify the enclosure in the first hour: matte black interior, diffused constant LED light, rigid camera mount, white reference patch, four corner fiducials, all board outputs in frame. The human builds it.
2. **`farm-verifier` service** (Python ≥ 3.8, OpenCV, numpy):
   - Capture into a ring buffer (~20 s) with monotonic timestamps.
   - Local HTTP on `127.0.0.1:8090` (C5): `observe`, `confirm_idle`, `calibrate`, `snapshot`, `stream` (cropped to ROI, ≤ 10 fps), `health`.
   - Never serves the full frame.
3. **Calibration:** auto-ROI from idle patterns (C8): Uno Q corner pixels → homography; Pico LEDs by temporal differencing. Manual override in `verifier/rois.yaml`. Drift check < 5 s before each observe. Brightness thresholds learned from idle.
4. **Assertions** (pure functions over frames, C6):
   - Priority: `led_sequence` (step segmentation, per-step LED set and duration), `matrix_frame` (8×13 grid, adaptive threshold, `tol_cells`, hold time), `led_blink`.
   - Then `led_state`, `rgb_color`, `matrix_text`.
   - Every result has measured/expected/uncertainty/detail. Report "cannot verify" near Nyquist. No pass without a measurement.
5. **`confirm_idle`** for hand-over: verify the idle pattern within 10 s, else return a reason.
6. **Evidence:** per observe, write an MP4 + GIF (< 3 MB) of the cropped ROI with a burned-in overlay (assertion, measured value, verdict, timestamp, "recorded by the Farm camera") and 2–3 key frames into the evidence dir rigd gives you.
7. **Synthetic frame generator** (`verifier/synth/`) for the Pico LED bank and the Uno Q matrix with noise/blur/drift. Unit tests for every assertion, including wrong answers that must fail. Record real sample clips (`verifier/samples/`) as soon as hardware exists and use them as regression tests via `farm-verifier replay`.
8. **CLI:** `farm-verifier calibrate | observe --assertions a.json | record | replay --video x.mp4` (replays labelled).
9. **Docs:** `verifier/SETUP.md` (enclosure, camera, privacy framing, pre-demo checklist) and `verifier/ASSERTIONS.md` (methods, limits, "what would fool it"). D uses ASSERTIONS.md as pitch material.

**Acceptance:** on real footage, `led_sequence` and `matrix_frame` give correct verdicts on reference solutions and wrong ones on trap starters. A 10 s observe returns < 15 s including clip encoding. `confirm_idle` < 10 s. Average CPU ≤ 1 core, RAM ≤ 600 MB. Survives a camera unplug/replug.

**Milestones:** T+1 enclosure spec + camera facts; T+4 service with synth frames + local API; T+8 `led_sequence` on real Pico footage; T+12 `matrix_frame` + `confirm_idle` + clips; T+16 freeze; then robustness (someone walks past, lighting change, 2 h soak).

---

## Lane C: Tailnet, control plane & Devin (`tailnet/`, `control/`, `session-kit/`, `experiments/`, `docs/CONTRACTS.md`)

**Goal:** get cloud Devin sessions onto the tailnet with per-session identity, aggregate every rig into one graph, and drive sessions from the control plane.

**Build:**
1. **Day-0 (G1–G4, G8, G9). These gate the whole design; do them first.**
   - A throwaway Devin session installs Tailscale and joins with a pre-auth key (kernel mode, else userspace + HTTP proxy), then curls `rig-1:8080/v1/rig`.
   - Confirm `session_secrets` arrive as env vars; that a Tailscale OAuth client can mint one-off ephemeral tagged keys; that Devin can view an image URL; that Funnel works on the control node.
   - If G1 fails, switch to the documented fallback (control proxies rigd via Funnel with per-session bearer tokens) and tell the team by T+1.5.
2. **Tailnet:** `tailnet/policy.hujson` (C0) applied by the human; tags; ACL tests (`tailscale debug` / a session node trying :8081, :22, :8090 must fail).
3. **`session-kit/`:** `farm-join.sh` (idempotent; detects sudo/TUN; userspace fallback; exports `FARM_PROXY`); a `farm` CLI (bash + curl + jq) wrapping C1 with friendly errors; `SKILL.md`/playbook text: rig check → describe → lease → run → logs → verify → read results → iterate → release → PR with the public evidence URL → structured claim (C11). Register it as a Devin playbook via the API.
4. **`farm-control`** (Python FastAPI, or TypeScript Hono if D prefers one language; decide by T+1):
   - Rig discovery by `tag:rig`; subscribe to each rig's SSE; build the graph (FRONTEND §3); merged SSE `/api/events`.
   - Devin API v3 client: create with `session_secrets`, `playbook_id`, `max_acu_limit`, `tags`, `structured_output_schema`; poll status/messages every 5 s; send message; archive.
   - Mint the join key per session; map `devin-<farm_id>` ↔ session.
   - Stop = archive + revoke leases + delete the node.
   - Poll proxy; admin proxy; ACU budget guard.
   - Evidence republish (`/e/<id>`) with an OpenGraph image.
   - Event recorder (ndjson) for replays.
   - Operator UI over `tailscale serve`; public read-only over Funnel.
   - `farm-control doctor`.
5. **GitHub (Should):** PR comment with the verdict table + GIF via `GITHUB_TOKEN`.
6. **Experiments** (`experiments/`):
   - Pre-register `PLAN.md` before running.
   - **E1:** claimed vs confirmed. Arms `nofarm` / `farm` (an `outpost` arm only if time allows) × tickets incl. traps × 3 reps. Claims from structured output. Graded independently by `grade.py`, which re-runs each final SHA through the real API with the hidden `assertions.json`. Report counts + Wilson CIs.
   - **E2:** hardware duty cycle from rig events.
   - Raw JSON committed; plots generated by script.
   - Launcher: `experiments/launch.py --arm --tickets --reps --max-acu --max-parallel`.

**Acceptance:** from the operator UI, "New session" produces a Devin session that joins the tailnet as `devin-s-…`, leases a board on rig-1, verifies, and releases, and the graph reflects every step. Prompting from the UI reaches the session. Public Funnel map loads for an anonymous browser. ACU guard refuses past the cap.

**Milestones:** T+1.5 Day-0 verdicts + contracts v1.0 frozen; T+4 control against `rigd --mock-drivers` + a mock Devin client; T+8 a real session on the tailnet end to end; T+12 multi-session + prompting + Funnel; T+16 freeze; then experiments + PR evidence.

---

## Lane D: Frontend, story & submission (`web/`, `docs/pitch/`, `docs/media/`, `README.md`, `docs/SUBMISSION.md`)

**Goal:** the bubble map everyone sees, plus everything we submit.

**Build:**
1. **`web/`** per `docs/FRONTEND.md`: React + Vite + TS, React Flow + d3-force.
   - Session / rig / device / camera bubbles; `attached` / `watches` / `lease` / `queue` edges with the specified encoding; live device thumbnails.
   - Drawers for session (status, messages, **prompt box**, stop), device (live crop, holder/token/queue, run + logs, verdict table, **Poll**, reset/revoke), and rig (health, maintenance).
   - "+ New session" modal; ⌘K; timeline scrubber; LIVE/REPLAY/MOCK badges; reconnect handling.
   - Public build (`VITE_PUBLIC=1`).
2. **Mock-first:** `web/fixtures/demo.ndjson` scripted to tell the demo story (3 sessions, 1 queued, ✗ → fix → ✓, hand-over), working by T+4 with no backend. Then switch to C's control API against `rigd --mock-drivers`, then live.
3. **Evidence page** design (served by control; D owns the template): clip, key frames, expected vs measured table, SHA, rig, verdict banner; OpenGraph image.
4. **Submission** per `docs/SUBMISSION.md`: README (hero GIF, pitch, architecture, quickstart, limits), architecture SVG with the tailnet trust boundary, media (rig photo from B, hero shots, hand-over GIF), storyboard → shot list → film → edit → captions → VO, Devpost text, Q&A crib, live demo runbook, two rehearsals, recorded backup replay.
5. **Design:** dark night-lab theme, mono numerals, strict colour semantics (green/red only for camera verdicts), legible at 1080p. Apply the `frontend-design` principles: a distinctive identity, not a template.

**Acceptance:** mock mode tells the whole story with zero backend; live mode shows real sessions/leases/verdicts < 2 s behind reality; a 3-second screenshot answers "who holds which board, who's waiting". The video is ≤ 3:00 and every shot is real or labelled. The README renders with images on GitHub.

**Milestones:** T+2 storyboard + design direction + fixture stream; T+4 map in mock mode; T+8 against control on mock rigd; T+12 live + drawers + prompting; T+14 architecture SVG; T+16 freeze; T+18 rehearsal 1 + B-roll; T+21 rehearsal 2, video locked, Devpost submitted.

---

## Integration calendar

| When | Who | What |
|---|---|---|
| T+0 | all | Tailnet created, everyone invited, rig-1 online with `tag:rig`; repo cloned; lanes start Day-0 checks |
| T+1.5 | C (+A) | Day-0 verdicts; contracts v1.0 frozen; fallback decision if G1 failed |
| T+4 | all | Standalone demo of every component on mocks; D shows the map on fixtures |
| T+8 | A+B+C | First real session end to end on `pico-1` |
| T+12 | all | Multi-session + queue + hand-over live on the map; prompting from the UI |
| T+16 | all | Feature freeze; E1 launched |
| T+18 | all | Rehearsal 1; filming |
| T+21 | all | Rehearsal 2; backup replay; submit |
