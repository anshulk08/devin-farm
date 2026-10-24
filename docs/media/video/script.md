# Devin Farm demo video: shot-by-shot script (2:45)

Team: the corgis. Repo: github.com/anshulk08/devin-farm. Every shot is real footage or carries an on-screen label (RECORDED RUN / REPLAY / MOCK / Sped up N×). Placeholders in [brackets] come from real runs or `experiments/results/`; if we don't have the number, cut the line. Graphics: `card-*.png|mov`, `lt-*.png|mov` in this folder (VO column names the asset).

Pace: about 150 words/min, so each VO line fits its slot with a breath to spare. VO is recorded last against the locked cut. No music under the first 12 s.

| # | Time | Picture | On-screen text / asset | Voiceover |
|---|---|---|---|---|
| 0 | 0:00-0:03 | `card-00-opener` (cold open, hard cut to shot 1) | DEVIN FARM, the corgis | (silence) |
| 1 | 0:03-0:09 | Devin session's final message claiming the LED sequence works (verbatim, [run id], date in corner), 5% push-in | `lt-recorded` ([date]) | "This agent just told us its LED code works." |
| 2 | 0:09-0:15 | Verifier `clip.mp4` of the same commit; wrong LED lit; overlay shows the real verdict text. Hard cut. | `lt-claimed-vs-camera` | "The board disagrees." |
| 3 | 0:15-0:20 | `card-01-problem` | Agents say done. The hardware disagrees. | "Agents write embedded code and judge it by their own logs. Wrong pin, flipped polarity, bad timing: logs can't see any of it." |
| 4 | 0:20-0:38 | Rig photo/B-roll, slow push-in; labels pop on Jetson, Pico, Uno Q, camera | `card-02-rig` (2 s, then `lt-one-rig`) | "So we built a rig. Real boards on a private Tailscale network, one camera watching them. A Devin session never gets a shell on it. It can only lease a board, push code, and ask for a verdict." |
| 5 | 0:38-0:58 | Bubble map (`?replay=` or live): three session bubbles appear, lease lines snap to boards, third shows dashed `#1` queue | `card-03-leases` (2 s), `lt-one-lock` | "Every board has one lock. Sessions hold a lease with a fencing token; everyone else waits in a queue you can see on the map." |
| 6 | 0:58-1:12 | Device drawer: verify ✗, expected vs measured table with units and ± | `card-04-verify` (2 s), `lt-measured` | "When code lands, a camera the agent can't touch measures what the board physically did. Not what it claimed. [measured vs expected, read verbatim from the run]" |
| 7 | 1:12-1:28 | Session reads the verdict, fixes, re-runs; verdict flips to ✓ (green = camera-confirmed); Uno Q matrix shows the image. Sped-up chip if compressed. | `lt-sped-up` ([factor]) if used | "The session reads the failure, fixes its own code, and runs again. This time the camera confirms it. [fix summary from the real run]" |
| 8 | 1:28-1:48 | Hand-over animation: release → resetting → idle ✓ → queued session gets the lease | `lt-handover` | "Before the next session touches a board, the rig resets it and the camera confirms it's idle. Only then does the queue advance." |
| 9 | 1:48-2:00 | Operator opens a session's drawer on the map, types a prompt, Devin replies | `lt-steer` | "From the same map, an operator can prompt any running session." |
| 10 | 2:00-2:12 | GitHub PR with evidence GIF + table ([PR link]) | none (PR is the proof) | "Evidence ships with the pull request: the clip, the measurements, the verdict." |
| 11 | 2:12-2:30 | E1 chart: claimed vs confirmed by arm | `card-05-evidence` (2 s), `lt-numbers` (n = [N], 95% CI [CI]) | "We measured it. Without Farm, agents claimed success [X of N] times and the camera confirmed [Y]. With Farm, [E1 result]." |
| 12 | 2:30-2:38 | `card-06-architecture` (tailnet trust boundary) | architecture diagram | "Sessions reach one port on a rig. The camera, the verifier and the admin API stay out of their reach." |
| 13 | 2:38-2:45 | `card-99-end` | the corgis, github.com/anshulk08/devin-farm, live map [PUBLIC URL] | "Devin Farm. Cloud agents share real hardware, and a camera checks the work. We're the corgis." |

## Colour rules for anything we overlay
Green only for camera-confirmed. Red only for camera-contradicted. Amber for claimed or unverified. Never use green/red decoratively. (The opener uses amber ✓ / red ✗ because that is exactly the story.)

## Timing checks
- 0:00-0:15 hook: three beats, no music.
- Shot 6 to 7 is the money beat; give it the full 30 s even if the rest is trimmed.
- If over 3:00, trim shot 9 first, then shot 10.

## Asset index
- Cards (PNG + `mov/*.mov`, ProRes 4444, 4 s, architecture 5 s): opener, 01-problem, 02-rig, 03-leases, 04-verify, 05-evidence, 06-architecture (mov only + `architecture-1080p.png`), 99-end.
- Lower thirds (PNG with alpha + `mov/lt-*.mov`, 4 s, slide-in + fade, alpha): claimed-vs-camera, one-rig, one-lock, measured, handover, steer, numbers, sped-up, recorded. Safe area 90%, bottom-left.
- `cover.png` 1280x640 for Devpost. Regenerate: `python3 build.py && sh build_mov.sh` (needs Pillow, ffmpeg, JetBrains Mono; architecture PNG was rendered from `../architecture.svg` in headless Chromium at 1920x1080).
