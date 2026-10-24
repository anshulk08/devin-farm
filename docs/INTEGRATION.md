# Integration playbook (PM / integrator)

The PM machine is wired to the Jetson (USB `192.168.55.1`, plus tailnet `rig-1` once A provisions it). It is the only place that merges to `main`, deploys to the rig, and signs off releases.

## 1. Branch model

- `main`: protected, always runnable, PM-merged only.
- Lane branches: `lane-a-rig`, `lane-b-verifier`, `lane-c-control`, `lane-d-web`. Short-lived feature branches `lane-x/<topic>` are fine.
- Integrator fixes: `pm/<topic>`, reviewed by the owning lane before merging.
- Tags: `rc-N` (passed the on-rig smoke test), `v1.0` (demo build). The demo runs only from a tag.

## 2. PR checklist (PM reviews every PR)

1. **Scope:** touches only the author lane's paths (CODEOWNERS enforces this); otherwise it needs the owner's approval.
2. **Contracts:** request/response/event shapes match `docs/CONTRACTS.md`. A contract change comes as a separate PR from C, merged first.
3. **CI green:** unit tests for the lane and the mock E2E (`ci/e2e_mock.sh`).
4. **Tests are real:** lease/queue/fencing races, assertion wrong-answer cases, contract shape tests; no tests that only check that a function runs.
5. **Safety invariants:** no agent code run on the rig host; services bind tailnet/localhost only (never `0.0.0.0`); no secrets (`ci/check.sh` scans); the verifier never serves a full frame; `log_contains` is never shown as confirmed.
6. **STATUS.md** updated (works / mocked / blocked).
7. **Hardware-touching PRs** (`rig/`, `verifier/`): deploy to the rig and run `ci/rig_smoke.sh` before merging; paste the result in the PR.

Merge order when several are ready: contracts → `rig/` → `verifier/` → `control/`/`session-kit/` → `web/` → docs. Squash-merge; the PR title becomes the changelog line.

## 3. Test layers

| Layer | Where | Command | Gate |
|---|---|---|---|
| Static + secrets | CI | `ci/check.sh` | every PR |
| Unit | CI | each lane's `pytest` / `npm test` | every PR |
| Mock E2E | CI + local | `ci/e2e_mock.sh` (exists once rigd mock + control land) | every PR after T+4 |
| On-rig smoke | Jetson | `ci/rig_smoke.sh [--ref SHA]` | hardware PRs, every `rc` |
| Full E2E with Devin | Jetson + Devin | 3 real sessions from the map (SUBMISSION §4) | `rc` from T+12, rehearsals |
| Soak | Jetson | 2 h with a looping fake session | before `v1.0` |

## 4. Rig access

- USB: `ssh rig-usb` (guru@192.168.55.1). Always available while the cable is in.
- Tailnet: `ssh rig-1` once provisioned (Tailscale SSH, `group:team`).
- First-time key install (human, once): `ssh-copy-id -i ~/.ssh/id_ed25519_jetson.pub guru@192.168.55.1`
- Deploys go through A's `rig/deploy.sh` once it exists. Never hand-edit files on the rig. Announce on-rig tests in the team channel, because the rig is shared.

## 5. Release / freeze

- T+16 feature freeze: only `fix:` PRs merge.
- Each `rc-N` gets: on-rig smoke record in `ci/results/`, a Must-list checklist update, a short changelog.
- `v1.0` = the last `rc` that passed two smoke runs in a row plus a rehearsal.

## 6. Must-list acceptance tracker

Fill in an evidence link (CI run, `ci/results/` file, video timestamp) per item from `docs/SCOPE.md` §5.

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| F1 | Rig API tailnet-only | | ☐ |
| F2 | One lease per device + FIFO queue; parallel devices | | ☐ |
| F3 | Fencing tokens + holder check | | ☐ |
| F4 | TTL/expiry/offline → reset → idle confirmed → next | | ☐ |
| F5 | Deploy by SHA; no host execution | | ☐ |
| F6 | `led_sequence`, `matrix_frame`, `led_blink` with uncertainty | | ☐ |
| F7 | Public evidence URL | | ☐ |
| F8 | Multi-board rig from config | | ☐ |
| F10 | Bubble map live ≤ 2 s | | ☐ |
| F11 | Poll hardware from UI | | ☐ |
| F12 | Session status in UI | | ☐ |
| F13 | Prompt a session from UI | | ☐ |
| F15 | Replay mode, labelled | | ☐ |
| F16 | Admin maintenance / revoke / reset | | ☐ |
