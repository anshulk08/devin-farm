# Design direction: bubble map and evidence page

One page. Source of truth for values is `web/src/styles/tokens.css`; the spec is `docs/FRONTEND.md` §4 and §7. If this file and the tokens disagree, the tokens win.

**Idea:** a dark night lab seen from above. The canvas is space, the bubbles are things that exist (agents, rigs, boards), and lines are relationships that are true right now. Colour carries meaning, and each meaning has exactly one colour.

## Palette

| Role | Token | Hex | Use |
|---|---|---|---|
| Ground | `--ground` | `#0B0F14` | Page and canvas background |
| Ground 2 | `--ground-2` | `#0F141B` | Regions (Devin cloud band, rig containers) |
| Panel | `--panel` / `--panel-2` | `#121821` / `#18202B` | Drawers, cards, table rows |
| Line | `--line` / `--line-strong` | `#243040` / `#34445A` | Borders, `attached` edges |
| Dot grid | `--dot` | `#1A2330` | Canvas dot grid, fades at the edges |
| Text | `--text` / `--text-dim` / `--text-faint` | `#D6DEE8` / `#8B97A7` / `#5D6A7A` | Primary, secondary, disabled |
| **Confirmed by camera** | `--ok` | `#3DD68C` | Camera verdict ✓ only |
| **Contradicted by camera** | `--bad` | `#F2555A` | Camera verdict ✗ only |
| **Self-reported, waiting, degraded** | `--warn` | `#F5B544` | `log_contains`, blocked sessions, rig throttled |
| **Offline** | `--off` | `#5A6573` | Offline rigs/devices, ended sessions |
| Session hues | `--s0`…`--s7` | `#B48CFF` `#FF6FCF` `#FF9A4D` `#E8D14A` `#4FD6E0` `#FF9FB2` `#B9D36A` `#C9B8FF` | One per session: its ring, its lease and queue edges, its leased board's border |

Session hues avoid blue (the Uno Q matrix is blue), and avoid verdict green and red. Never use a session hue for status, and never use `--ok`/`--bad` for anything but a camera verdict.

## Type roles

| Role | Face | Size | Notes |
|---|---|---|---|
| Labels, headings, body | Inter Tight | 13–24 px (`--fs-sm` to `--fs-xl`) | Sentence case. 600 weight for names, 400 for prose |
| Numbers, tokens, timers, IDs, measurements | JetBrains Mono, tabular | ≥ 13 px | `tok 17 · 3:12`, `503 ms ± 33 ms`, `48.5 °C`. Always a unit and `±` on measurements |
| Badges (LIVE, REPLAY, MOCK) | Inter Tight 600 | 13 px | The only uppercase text in the product, because they are mode names |

## Encoding, in short

| Thing | Encoding |
|---|---|
| Session | Fixed-size circle, ring colour = Devin status (running, waiting amber, finished grey, error; see open points), hue = identity |
| Rig | Large rounded container; header with health pills; grey dashed border when offline |
| Device | Circle with a live cropped thumbnail (≥ 96 px). Border: free thin neutral; leased thick in holder hue; resetting dashed spinner; offline grey strike |
| `lease` edge | Thick solid, holder hue, particles only while work is running, label `tok N · m:ss` |
| `queue` edge | Dashed, holder hue at 50 %, badge `#1`, `#2` at the device end |
| `attached` / `watches` | Thin solid neutral / faint dotted, brightens during verify |
| Verdict | Ring flash on the device: green ✓ or red ✗ (camera), amber for self-reported. A toast states the detail in words |

## Motion

- **The hand-over is the one bold moment.** Lease retracts up (≈ 300 ms) → resetting spinner → camera tick (idle confirmed) → the `#1` queue line fills in solid (≈ 400 ms, `--ease`). Nothing else on screen moves while it plays.
- Everything else is quiet: lease snap ≈ 200 ms, verdict ring one pulse, queue advance slides one slot.
- Particles only while a run or verify is active. No idle animation, no hover wobble, no layout reshuffles (positions are pinned after the first settle).
- `prefers-reduced-motion`: no particles, no pulses, state changes are instant. The order of states is still shown (resetting → idle ✓ → granted) as text in the toast.

## Video legibility

- Test every screen at 1920×1080 and again scaled to 50 %. If a label is unreadable at 50 %, it is too small.
- Labels ≥ 13 px, thumbnails ≥ 96 px, edge labels ≥ 13 px mono.
- Keep anything that matters out of the outer 5 % (players crop and overlay controls there).
- One focal point per shot. Close drawers we aren't talking about.
- Contrast: body text on `--ground` is ≥ 7:1; dim text is only for secondary facts.

## Evidence page

- Verdict banner first: ✓ or ✗ in the verdict colour, with the assertion type and one-line detail.
- Then the clip (autoplay muted, loop), key frames, and the expected vs measured table in mono with units and ±.
- Then provenance: repo, SHA (mono, copyable), rig, device, time, verifier version, "Recorded by the Farm camera".
- OpenGraph image: verdict + assertion + one frame, readable as a 600 px wide preview in a PR.

## Do / don't

| Do | Don't |
|---|---|
| Use green and red only for camera verdicts | Use green for "online", "success" or "connected" |
| Show a measurement with its unit and ± | Show a bare pass/fail with no number |
| Badge LIVE, REPLAY or MOCK at all times | Let a replay or mock look live |
| Keep the last known graph on SSE loss, greyed, with a banner | Blank the screen or show a spinner over the map |
| Write buttons as the action: "Send message", "Reset board", "Stop session" | "Submit", "OK", "Go →" |
| Keep labels short and specific: `pico-1 · leased by s-1a2b · tok 17` | Decorative eyebrows, all-caps labels, emoji in UI text |
| Pin node positions after the first layout | Re-run the force layout on every event |

## Open points

- FRONTEND §4 gives session rings "running = pulsing teal" and "error = red", but the tokens have no teal and §7 reserves red for camera verdicts. Proposal: running = `--text` ring with a slow pulse, error = `--off` ring with an ✗ glyph and the word "error" in the tooltip. Needs a decision from D + PM before T+4.
