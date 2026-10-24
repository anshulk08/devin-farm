# Live demo runbook (print this)

From `docs/SUBMISSION.md` §4. Slot: 3–5 min with screen share. Run from the `v1.0` tag. Tick boxes with a pen.

**Roles:** Presenter (talks, drives the map) · Operator (laptop 2: drawers, prompts, fallbacks) · Rig (watches the rig, power, hotspot). Name them: P ______ O ______ R ______

## T-60 min

- [ ] `rig/health.sh` passes: camera frame age < 2 s, both idle patterns camera-confirmed, temp < 70 °C
- [ ] `farm-control doctor` passes: tailnet peers, Devin API, ACU budget, Funnel up
- [ ] Public map loads in a private window on a phone (not on the tailnet)
- [ ] Phone hotspot on and tested with rig + control laptop
- [ ] Backup replay `?replay=rehearsal-2` opens and shows REPLAY
- [ ] Demo video file open in a second tab, muted, at 0:00
- [ ] Hook clip (10 s false claim) loaded
- [ ] Notifications off, bookmarks bar hidden, browser zoom 100 %, screen resolution set

## T-15 min

- [ ] Start 3 sessions from "+ New session": `pico/led-sequence-trap`, `unoq/matrix-heart`, `pico/led-sequence`
- [ ] All 3 bubbles go from hollow (joining) to filled (on the tailnet)
- [ ] Two leases granted, third queued `#1`
- [ ] Screen recorder running (this run is our backup)
- [ ] ACU budget shows enough for the slot

## On stage (4 min)

| Time | Do | Say (gist) |
|---|---|---|
| 0:00 | Play the 10 s false-claim clip | "Agents say done. The board disagrees." |
| 0:20 | Map, live. Point at the queue line and the fencing token | "One lock per board. Everyone else waits, in order." |
| 1:00 | Open the drawer of the board being verified; read the measured result aloud | "This is what the camera measured, with the error bar." |
| 2:00 | Prompt a session from its drawer: "Show the camera result in your PR." | "We can steer any agent from here." |
| 2:40 | Hand-over if one happened; else Operator releases from the drawer: reset → idle ✓ → next grant | "Wiped, checked by the camera, then handed on." |
| 3:20 | The PR with evidence; the E1 chart; close with the live link | Numbers only from `experiments/results/` |

## If something breaks (act within 15 s)

| Symptom | Do | Say |
|---|---|---|
| One session slow or stuck | Talk over the other two; prompt it from the map | "That one's still thinking; here's another." |
| Rig offline on the map | Rig person: switch to hotspot. Still down after 30 s: open `?replay=rehearsal-2` | "Switching to a recording of this morning's run. The badge says REPLAY." |
| Devin API down | Show sessions already running; else the replay | "Devin's API is down; this is a recording." |
| Verifier says "not visible" | Show it; then the replay of a clean verdict | "It refuses to guess when it can't see the board. That's on purpose." |
| Everything down | Play the demo video | "Here's the recorded version." |

**Never** present a replay or mock as live. If the badge isn't LIVE, say so out loud.

## After

- [ ] Stop the 3 sessions from the map (archives them, revokes leases, removes their nodes)
- [ ] Save the screen recording and control's event log for this run
- [ ] Note what broke in `docs/pitch/REHEARSAL.md`
