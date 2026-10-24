# Demo video: shot list (2:45)

Refines the storyboard in `docs/SUBMISSION.md` §3 into shots we can film. Owner D; every lane films something (see the capture checklist at the end).

**Rules that apply to every shot**
- Real footage only, or labelled. A shot is one of: **Live** (a real run, real time or sped up with a visible label), **Recorded run** (a real run played back from control's ndjson with `?replay=`, badge shows REPLAY), or **Simulation** (mock/fixture data, badge shows MOCK). Nothing else.
- Sped-up footage carries a caption chip `Sped up 8×` (or the real factor) and keeps the map's own clock visible.
- Captions are sentence case, burned in, bottom third, inside the 90 % safe area. One caption on screen at a time, ≤ 9 words.
- Screen capture: 2560×1440 at 100 % browser zoom, exported at 1920×1080. Hide the bookmarks bar and OS notifications. Use the operator build unless the shot is about the public view.
- Record VO last, against the locked cut. Plain voice, no music under the first 12 s.
- Every number on screen comes from a real run or from `experiments/results/`. If we don't have it, we cut the shot. We never film a placeholder.

**Capture methods used below**
- **Screen**: macOS screen recording of the browser at 2560×1440.
- **Verifier clip**: the verifier's own `clip.mp4` from an evidence bundle (C7), with its burned-in overlay. This is the evidence, so we use it unedited apart from trims.
- **Phone**: phone on a tripod, 4K 30 fps, locked exposure, for rig B-roll.

## Shots

| # | Time | On screen, exactly | Capture | Caption | VO draft | Label |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:06 | Devin web app, one session's final message claiming the LED sequence works (quote it verbatim, from a real `pico/led-sequence-trap` run; best source is an E1 `nofarm` run). Slow 5 % zoom onto the message. | Screen | The agent says it's done. | "This agent just told us its LED code works." | Recorded run (date in small text, top right) |
| 2 | 0:06–0:12 | Verifier clip of that same commit: the wrong LED lit, overlay shows the run's real verdict text (the C6 example reads `led_sequence ✗ step 2: LED 0 still on`; use whatever the run actually measured). Hard cut from shot 1, no transition. | Verifier clip (from `grade.py` re-running the final SHA) | The camera says it isn't. | "The board disagrees." | Recorded run. Small text: "Same commit, re-run on the rig" |
| 3 | 0:12–0:24 | Rig in its enclosure, slow push-in. Labels fade in one at a time: Jetson, pico-1, unoq-1, camera. | Phone | One rig, two boards, one camera. | "We built a lab that cloud agents can share. A Jetson hosts the boards. A fixed camera watches them." | Live footage (B-roll) |
| 4 | 0:24–0:32 | `docs/media/architecture.svg`, zooming from the full diagram to the session arrows hitting `:8080` and the blocked list. | Screen (SVG in browser) | Agents reach one port. Nothing else. | "Each Devin session joins our private network with a one-off key. It can reach one port on the rig: no shell, no camera, no admin." | Diagram |
| 5 | 0:32–0:50 | Bubble map, operator build, LIVE badge. Three session bubbles appear in the top band. Two lease lines snap to `pico-1` and `unoq-1`. The third session's dashed queue line lands on `pico-1` with badge `#1`. Hover the lease edge once to show `tok 17 · 3:12`. | Screen, sped up | One lock per board. Everyone else waits. | "Three agents, two boards. Each board has exactly one holder. The third agent queues, and the map shows who's waiting." | Live, `Sped up 8×` chip |
| 6 | 0:50–1:05 | Click `pico-1`. Device drawer: verdict ✗ ring, expected vs measured table for step 2 (shape as in the C6 example: expected LED 1, measured LEDs 0 and 1, duration in ms ± uncertainty; real values from the run). Cursor rests on the ± value. | Screen | Measured, not claimed. | "When the agent asks for a check, the camera measures what the board did, with units and an error bar." | Live |
| 7 | 1:05–1:20 | Session drawer for the same session: Devin's message quoting the measured result, then its next commit. Cut to the new verifier clip: overlay `led_sequence ✓`. Back to the map: green ring flash on `pico-1`. | Screen + verifier clip | It reads the result and fixes the code. | "The agent reads the measurement, finds the wrong pin, pushes a fix, and runs it again. This time the camera agrees." | Live, `Sped up 8×` on the session part only |
| 8 | 1:20–1:40 | Hand-over at real speed: lease line retracts upward, `pico-1` shows resetting (dashed spinner), then idle confirmed (camera tick), then the `#1` queue line turns solid and the token goes to `tok 18`. Hold 2 s on the end state. | Screen, real time | Reset and checked before the next agent. | "When it lets go, the rig wipes the board and the camera confirms it's idle. Only then does the next agent get it, with a new token." | Live, real time |
| 9 | 1:40–1:55 | Operator types in a session drawer's prompt box: "Link the camera evidence in your PR." Press Enter. Devin's reply appears in the message list. | Screen | Steer any agent from the map. | "From the same screen we can talk to any session." | Live (reply wait cut, marked with a jump cut) |
| 10 | 1:55–2:10 | GitHub PR from a real session: the evidence comment with GIF and results table. Click the link: the public evidence page `/e/<id>` with the clip, key frames, SHA and verdict banner. | Screen | Evidence ships with the pull request. | "The proof lands on the pull request, so a reviewer sees what the board did, not what the agent said." | Live |
| 11 | 2:10–2:30 | E1 chart from `experiments/results/`: claimed vs camera-confirmed, by arm, with counts and 95 % Wilson intervals. Highlight the gap bar. | Screen (static chart, slow pan) | Claimed versus confirmed, n = TODO (E1). | "Across TODO (E1) runs, agents without the farm claimed success TODO (E1) times. The camera confirmed TODO (E1)." | Data. Cut this shot if E1 isn't done; extend shot 8 instead |
| 12 | 2:30–2:45 | Architecture card, team names, live map URL and repo URL. Live map in the background, dimmed. | Screen | Live map: TODO URL | "Devin Farm. Real boards, shared safely, judged by a camera." | Diagram + live |

Total: 165 s. Timings leave 0–5 s slack per shot for VO pacing.

## B-roll list (film once, cut where needed)

| Clip | Length | Capture | Notes |
|---|---|---|---|
| Rig wide, enclosure open, power on | 10 s | Phone | Matte black interior visible; no faces, no screens with secrets |
| Close-up: Pico LED bank running the idle pattern (LED 0 at 0.5 Hz) | 8 s | Phone | Exposure locked so LEDs don't bloom |
| Close-up: Uno Q matrix idle (corners + centre heartbeat) | 8 s | Phone | Same |
| Uno Q matrix showing the heart from `unoq/matrix-heart` | 6 s | Phone + verifier clip | Pair the two for a "same moment, two views" cut |
| Camera on its mount, slow rack focus | 6 s | Phone | |
| Hand on keyboard, map on monitor (no readable secrets) | 6 s | Phone | For transitions only |
| Verifier clips: trap ✗, fix ✓, idle confirm, matrix ✓ | as recorded | Verifier clip | Keep the original files; name them `vc-<evidence_id>.mp4` |
| Map at rest with 3 sessions, 30 s, no cursor | 30 s | Screen | Backdrop for shot 12 and for titles |
| Public map in a private browser window | 10 s | Screen | Shows it works with no tailnet |

## Capture checklist by lane

**A (rig)**
- [ ] Rig photo for `docs/media/rig.jpg` (T+12): even light, enclosure open, every board and the camera in frame.
- [ ] Phone B-roll above, at the venue setup if possible.
- [ ] Confirm the trap ticket's wiring before filming shot 2, so the ✗ is the real trap and not a loose wire.

**B (verifier)**
- [ ] Keep every evidence bundle from rehearsals; tell D the ids for: trap ✗, fix ✓, idle confirm, matrix ✓.
- [ ] Check the clip overlay text is readable at 1080p (≥ 24 px at clip scale).

**C (control, Devin, experiments)**
- [ ] Record control's event stream for every rehearsal (`farm-control record --out rehearsal-N.ndjson`) so any run can become a REPLAY.
- [ ] Screen-capture the Devin web app for the session used in shots 1 and 7. Redact org name if needed.
- [ ] One real PR with the evidence comment (shot 10); share the link.
- [ ] E1 raw data and chart in `experiments/results/` with n and CIs (shot 11). No chart, no shot.

**D (map, story)**
- [ ] Screen captures for shots 4–10 at 2560×1440, browser zoom 100 %, cursor highlight off.
- [ ] A 6 s hand-over GIF for `docs/media/handover.gif` and a hero still for `docs/media/hero.png` (from shot 8 and shot 5).
- [ ] Captions file (`docs/media/captions.srt`) from the table above; burn in at export.
- [ ] VO recorded last; check every number against its source file.

**PM**
- [ ] Film from the `rc` tag that passed `ci/rig_smoke.sh`; note the tag in the video description.
- [ ] Before the final export, check every shot's label against its source (live, recorded run, simulation).

## Fallbacks

| If we don't have | Do this |
|---|---|
| A real false claim (shot 1) | Use a real trap run where the agent claimed success before verifying. If none exists, open on shot 6 instead. Never stage a claim |
| A live hand-over on camera | Use the rehearsal recording with `?replay=`; the REPLAY badge stays visible |
| E1 numbers | Cut shot 11; spend the time on shot 8 |
| A real PR comment | Show the public evidence page only, and say "linked from the PR" only if it is |
