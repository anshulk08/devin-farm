# Submission form copy (paste-ready)

Form closes for edits at **5:00 pm**. Fields marked ⟨fill⟩ need a real value from today's run; never paste a number we did not measure.

## The basics

**Team name:** the corgis

**Project name:** Devin Farm

**One-line pitch** (pick one):
1. A shared hardware lab for cloud agents: one lock per board, a queue for everyone else, and a camera that decides whether the code actually worked.
2. Devin sessions lease real boards over a private network, and a camera, not the agent, says whether it worked.

## Elevator pitch (200 chars max)

Run parallel cloud Devin agents on real hardware, securely and correctly: one lock per board, a queue for the rest, and a webcam, not the agent, decides if the code worked.

## Description

Devin Farm: Run parallel cloud agents on real hardware, securely and correctly.

- **Security.** Every session is confined to the one board it leases: its own one-off Tailscale key, ACL tags, and a rig that resets the board to a known idle program. A bad flash stays on one board.
- **Parallelism.** Several Devin sessions share one rig. Leases with fencing tokens mean one driver per board, and the queue hands over automatically.
- **Convenience.** The rig is always on. Start a session from anywhere; no one has to carry a board home.
- **Correctness.** A private webcam verifier checks what the hardware physically did. `log_contains` and self-reported output never count as a pass.

## What it does

Agents that write embedded code say "done" because the logs look right. The board often disagrees. Devin Farm gives cloud Devin sessions real hardware without trusting them about the result.

A Jetson Orin Nano (`rig-1`) sits on a desk with an Arduino Uno Q and a Logitech BRIO webcam, always on and joined to our Tailscale network. A Devin session joins the same network, asks the rig for a board, and either gets a lease or waits in the queue with a visible position. It pushes code by git SHA, runs it, and asks the rig to verify. The camera returns a verdict: did the 8x13 LED matrix show the heart? A Pico driver exists, but we have no board for it yet, so we have not tested it. When the session lets go, the rig resets the board to idle. A live bubble map shows sessions, boards, and who is waiting, and every run gets a public evidence page.

## How it works

```
Devin session (cloud VM)
  | TS_AUTHKEY: one-off, ephemeral, tag:devin-session
  v
Tailscale ACL: sessions reach rig :8080 only
  v
rigd (Jetson): identity from tailscale whois -> lease + FIFO queue + fencing token
  |--> driver flashes the board by SHA
  |--> camera verifier (OpenCV): matrix_frame verdict, board crop only
  v
farm-control (tag:control) <-- rig events --> web UI (?view=graph, /e/<id>)
```

- **The rig.** `farm-rigd` runs on the Jetson. It takes caller identity from the Tailscale peer, not from API keys. Sessions never get a shell on the rig; agent code runs only on the target board.
- **Lease and queue.** One lock and one FIFO queue per device. Every lease-scoped call must come from the holder and carry its fencing token, so a stale session cannot overwrite a newer one.
- **Camera verifier.** It exposes only the board region and returns per-cell on/off results for the LED matrix.
- **Control and UI.** `farm-control` launches Devin sessions, mints each one's join key, and serves the operator UI and evidence pages.

## How we built it

- **Rig:** Python and FastAPI `rigd` with SQLite on the Jetson.
- **Network:** Tailscale ACL tags (`tag:rig`, `tag:control`, `tag:devin-session`). Control exchanges an OAuth client for one-off, ephemeral, pre-authorized keys that expire in an hour, and deletes the node when the session stops.
- **Devin:** API v3 sessions. Control passes `TS_AUTHKEY` and `FARM_ID` as `session_secrets`, sets an ACU cap, and requests a structured-output claim.
- **Verifier:** OpenCV with a homography fitted to all 104 LEDs (0.4-0.5 px residual on our rig).
- **UI:** React, Vite, and TypeScript, with a React Flow bubble map, a dashboard, drawers, and a replay player.
- **Four lanes:** (A) rig and hardware, (B) camera verifier, (C) tailnet, control plane and Devin, (D) web and story, plus a PM who integrated everything. Lanes met only at `docs/CONTRACTS.md`, and each ran standalone against mocks first.

## What Devin did / does

**As the product's user.** Each cloud session reads its ticket, joins the tailnet with its own key, leases a device, pushes a SHA, runs it, verifies with the camera, iterates on the measured result, and releases. [LIVE RESULT PENDING: tickets run, pass/fail counts, any false "done" the camera caught, session link]

**As a builder.** The git history lists humans as authors. Each lane owner worked with a coding agent from a per-lane brief in `docs/WORKSPLIT.md`. The history does not show which parts Devin wrote, so we claim none. [LIVE RESULT PENDING: Devin-authored changes, if any, with session links]

## Challenges

- Making "the agent cannot fake it" real: the verdict comes from a camera the session cannot reach, and only cropped board regions leave the rig.
- Camera calibration: mapping image pixels to 104 individual LEDs under real lighting.
- Per-session identity without static keys: OAuth-minted ephemeral keys plus tag-scoped ACLs.
- Keeping mock data honest. Mock and replay views carry a "Mock data" badge, and red appears only for measured contradictions.

## What's next

- Pico and more boards on the rig.
- A signal/logic analyzer verifier (future work; none is in use today).
- Multiple rigs on one map.

## Links

- **Demo link:** ⟨fill: YouTube unlisted URL of the video⟩ (fallback: public map URL)
- **Repo link:** https://github.com/anshulk08/devin-farm
- **Devin session:** ⟨fill: the session from the video, ideally the one where the camera caught a false "done"⟩

## Team

Adrian (submitter) adds: anshul.kollur@gmail.com, rr.lakki@gmail.com, subhamdash14@gmail.com.

## Pictures

| Slot | Content | Source file |
|---|---|---|
| Cover image | Rig hero shot with the title card | `docs/media/cover.png` |
| Screenshot 1 | Bubble map: three sessions, one queued | `docs/media/shot-map.png` |
| Screenshot 2 | Claimed ✓ vs camera ✗ verdict | `docs/media/shot-verdict.png` |
| Screenshot 3 | The rig: Jetson, Pico, Uno Q, camera | `docs/media/shot-rig.jpg` |
| Screenshot 4 | Architecture with the tailnet boundary | `docs/media/shot-architecture.png` |
