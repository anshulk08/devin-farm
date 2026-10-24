# Devin Farm

**Cloud agents share real hardware over a private network: one lock per board, a queue for everyone else, and a camera that decides whether the code actually worked.**

> Hackathon project, in progress. The final README (hero GIF, video, live link) is owned by Lane D. See `docs/SUBMISSION.md`.

## How it works

- **Rigs** (a Jetson with a Raspberry Pi Pico, an Arduino Uno Q and a camera) join a Tailscale tailnet as `tag:rig`.
- **Cloud Devin sessions** join the same tailnet with one-off ephemeral identities, lease a single board, deploy code by git SHA, and get **camera-measured evidence** back. Each device has one lock; other sessions queue.
- On release, the board is reset and the camera confirms it is idle before the next session gets it.
- **`farm-control`** discovers every rig, drives Devin sessions through the API, and serves a live **bubble map** of sessions, rigs, boards and their connections. From it you can poll hardware, watch session status, and prompt sessions.

## Docs

| File | What |
|---|---|
| [`docs/SCOPE.md`](docs/SCOPE.md) | Scope, requirements, architecture, decisions, Day-0 checks, milestones |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | Interface contracts v1.0-draft (tailnet ACL, rig API, leases, verifier, events, control API) |
| [`docs/WORKSPLIT.md`](docs/WORKSPLIT.md) | Four lanes, ownership, per-lane briefs, integration calendar |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Bubble-map UI spec: graph schema, visual encoding, interactions, design |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | Hackathon deliverables, video storyboard, live demo runbook, Q&A crib |
| `archive/v0.2-broker/` | Superseded cloud-broker design and the original agent prompts (reference only) |

## Repo layout (target)

| Path | Lane |
|---|---|
| `rig/`, `tickets/` | A: rig & hardware |
| `verifier/` | B: verifier & camera |
| `tailnet/`, `control/`, `session-kit/`, `experiments/`, `docs/CONTRACTS.md` | C: tailnet, control plane & Devin |
| `web/`, `docs/pitch/`, `docs/media/`, `README.md`, `docs/SUBMISSION.md` | D: frontend, story & submission |
