# Hackathon submission and live demo plan (owner D, everyone contributes)

Judged on: technical complexity, use of Devin, working demo, design, originality.

## 1. Deliverables checklist

| Item | Path / place | Owner | Due |
|---|---|---|---|
| Repo README (hero GIF, one-paragraph pitch, architecture image, quickstart, honest limits) | `README.md` | D | T+20 |
| Architecture diagram (SVG + PNG) showing the tailnet trust boundary | `docs/media/architecture.svg` | D (C reviews) | T+14 |
| Bubble-map hero screenshot + 6 s GIF of a hand-over | `docs/media/hero.png`, `handover.gif` | D | T+18 |
| Rig photo (enclosure, boards, camera) | `docs/media/rig.jpg` | B | T+12 |
| Evidence page screenshot + a real PR with an evidence comment | `docs/media/evidence.png`, PR link | C | T+16 |
| Experiment chart(s) from raw data | `experiments/results/*.png` | D | T+18 |
| Demo video, 2:30–3:00, 1080p, captions burned in | YouTube (unlisted) + `docs/media/demo.mp4` (LFS or link) | D (all film) | T+21 |
| Devpost text (inspiration, what it does, how we built it, challenges, accomplishments, learnings, what's next, built with) | `docs/pitch/DEVPOST.md` | D | T+21 |
| Public live link (Funnel bubble map), uptime-checked | control | C | T+16 |
| Backup replay link (labelled) | control `?replay=` | D | T+21 |
| Live demo runbook (this file §4) rehearsed twice | | all | T+21 |

## 2. Story

**One-liner:** "Cloud agents share real hardware over a private network, one lock per board, and a camera decides whether their code actually worked."

**Problem → insight → product → proof:**
1. Agents write embedded code and say "done" based on logs. The hardware often disagrees (wrong pin, wrong timing, polarity).
2. Insight: verification must be independent of the agent, and hardware must be shareable without giving agents a shell.
3. Farm: rigs on a tailnet, per-device leases + queue + fencing, a camera oracle, evidence on the PR, and a live map of it all.
4. Proof: the E1 numbers (claimed vs confirmed), a live hand-over, a real PR.

**Honest positioning (say it before judges ask):** Outposts already lets Devin run on your own machines, several at once. Farm is different in three ways: sessions never get a shell on the rig; locking happens per board, with a queue and fencing across many sessions; and a camera the agent can't touch produces the verdict.

## 3. Video storyboard (2:45)

| t | Shot | On-screen text | VO gist |
|---|---|---|---|
| 0:00–0:12 | Split: Devin chat "Done ✅ LEDs sequence 0→1→2" / camera shows the wrong LED lit | **CLAIMED ✓ · CAMERA ✗** | "Agents say done. Hardware disagrees." |
| 0:12–0:30 | Rig photo, slow push-in; labels pop on Jetson, Pico, Uno Q, camera | "One rig. Many boards. One camera." | What the rig is |
| 0:30–0:50 | Bubble map: three session bubbles appear, lease lines snap to boards, third shows dashed `#1` | "One lock per board. Everyone else queues." | Tailnet + leases |
| 0:50–1:20 | Device drawer: verify ✗ with measured table; session reads it, fixes, re-runs ✓; matrix shows the image | "Measured, not claimed." | The verifier loop |
| 1:20–1:40 | Hand-over animation: release → resetting → idle ✓ → queued session gets the lease | "Reset, confirmed by camera, before anyone else touches it." | Safe sharing |
| 1:40–1:55 | Operator prompts a session from the map's drawer; Devin replies | "Steer agents from the map." | Control plane |
| 1:55–2:10 | GitHub PR with evidence GIF + table | "Evidence ships with the PR." | Review flow |
| 2:10–2:30 | E1 chart: claimed vs confirmed by arm, with counts | "n = …, 95 % CI" | Numbers |
| 2:30–2:45 | Architecture card + team + link | "devin-farm · live map: <url>" | Close |

**Production notes:**
- Capture screen at 2560×1440 and export at 1080p.
- Capture the camera with the verifier's own clip output (that's the evidence) plus a phone on a tripod for the rig B-roll.
- Real sessions take minutes, so time-compress with a visible on-screen clock ("× 8").
- Captions are burned in. Music is quiet and royalty-free.
- Record the VO last, against the locked cut.
- Every shot must be real footage or explicitly labelled REPLAY/SIMULATION.

## 4. Live demo plan

**Format assumption:** a 3–5 minute slot with screen share. The rig is at the venue (or at home on the tailnet); control runs on a VM.

**T-60 min:**
- Run `rig/health.sh` (camera frame age < 2 s, both idle patterns camera-confirmed, temp < 70 °C).
- `farm-control doctor` (tailnet peers, Devin API, ACU budget, Funnel up).
- Phone hotspot ready as a network fallback.

**T-15 min:**
- Start 3 sessions from the map ("+ New session", demo tickets: `pico/led-sequence-trap`, `unoq/matrix-heart`, `pico/led-sequence`). They need ~10 min to reach the interesting part.
- Start the screen recorder (to keep a backup of this exact run).

**On stage (4 min):**
1. 0:00 Hook, using the pre-recorded 10 s clip of a false claim.
2. 0:20 Bubble map, live. Point at the queue line and the fencing token.
3. 1:00 Open the device drawer for the session that's verifying; read the measured result aloud.
4. 2:00 Prompt a session from the drawer ("show the camera result in your PR").
5. 2:40 Hand-over, if one has happened; otherwise trigger release from the operator drawer to show reset → idle ✓ → next grant.
6. 3:20 The PR with evidence; the chart; close.

**Failure branches:**

| Symptom | Action (≤ 15 s) |
|---|---|
| A session is slow / stuck | Keep talking over the other two; prompt it from the map |
| Rig offline on the map | Hotspot; if still down, switch to `?replay=rehearsal-2` (badge shows REPLAY; say so) |
| Devin API down | Show sessions already running; else replay |
| Verifier says "not visible" | That's an honest failure mode; show it, then a replay of a clean verdict |
| Everything down | Play the demo video |

**Rehearsal script (10 min, run at T+18 and T+21):**
- Full run with a timer.
- One person plays the judge and asks the three hard questions: "why not Outposts?", "can the agent fake the camera?", "what if the agent writes malicious code?".
- Log what broke in `docs/pitch/REHEARSAL.md`.

## 5. Judge Q&A crib

- **Why not Outposts?** See §2. Also: Outpost workers give a shell; we give a lease on a single board, with a queue and fencing across sessions.
- **Can the agent fake the verdict?** It has no network path to the verifier: the ACL only opens rigd:8080, and the verifier listens on localhost. Assertions are data, the camera is physical, and reset is idle-confirmed. Limits: an agent could drive *extra* LEDs on its own board, and the camera resolution caps what we can measure.
- **Malicious code?** It runs only on the target board, never on the Jetson. USB is allowlisted against HID re-enumeration, and boards are wiped on reset. This is hackathon-grade, and `rig/SECURITY.md` lists the residual risks.
- **Scale?** Locks are per-rig, so adding rigs scales linearly, and control discovers them by tag. Cross-rig "any free Pico" scheduling is a next step.
