# Frontend: the bubble map (owner D)

One screen that *is* the system: every cloud session, every rig, every board and camera is a bubble; every relationship is a line. A judge should understand "three agents sharing two boards, one waiting" within 5 seconds without narration.

## 1. Stack

React + Vite + TypeScript, static build served by `farm-control`. Use **React Flow** (`@xyflow/react`) for nodes/edges/pan/zoom, with **d3-force** for layout (use `d3-hierarchy` for the rig→device cluster positions). Server-Sent Events from `/api/events` (operator) or `/pub/events` (public). No other state library: one `useReducer` store fed by events, snapshotted by `/api/graph` on connect.

Rejected: Cytoscape (heavier, less React-native), a pure d3 canvas (slower to build interactions), three.js (looks cool, reads badly in video).

## 2. Layout

```
                          ┌───────────── Devin cloud ─────────────┐
                          │  ( S·a1 )    ( S·b2 )    ( S·c3 )     │   ← session bubbles, top band
                          └─────┬───────────┬───────────┬─────────┘
                       lease ━━━┛           ┃           ┆ queue #1 (dashed, animated)
                                ┃           ┃           ┆
         ╭──────────────── rig-1 (Jetson) ─────────────────╮      ╭─── rig-2 ───╮
         │      ( pico-1 )━━━━━━━━━┛     ( unoq-1 )        │      │  ( pico-2 ) │
         │          ▲ ┄┄┄┄┄┄┄┄ ( 📷 camera ) ┄┄┄┄┄┄┄┄ ▲     │      │   offline   │
         ╰──────────────────────────────────────────────────╯      ╰─────────────╯
```

- **Top band:** session bubbles, ordered by creation time, inside a soft "Devin cloud" region.
- **Bottom band:** rig bubbles drawn as large rounded containers. Device bubbles are clustered inside their rig in the same physical left-to-right order as on the bench. The camera is a small bubble inside the rig.
- d3-force runs only *within* bands (collision + light centring), so sessions stay at the top and hardware at the bottom. The layout must never reshuffle on every event. Pin positions after the first settle; recompute only when nodes are added or removed.

## 3. Graph schema (`/api/graph`, C10)

```ts
type NodeKind = "session" | "rig" | "device" | "camera";
interface GNode { id: string; kind: NodeKind; parent?: string; label: string; status: string; data: Record<string, unknown>; }
type EdgeKind = "attached" | "watches" | "lease" | "queue";
interface GEdge { id: string; kind: EdgeKind; source: string; target: string; data?: { position?: number; token?: number; expires_at?: number } }
```
IDs: `session:s-1a2b3c4d`, `rig:rig-1`, `device:rig-1/pico-1`, `camera:rig-1`.

## 4. Visual encoding (what makes the connections intuitive)

| Element | Encoding |
|---|---|
| **Session bubble** | Circle with the Devin avatar initial + short title. Ring colour = Devin status (running = pulsing teal, blocked/waiting for user = amber, finished = grey, error = red). Small ACU counter on the ring. Size is fixed |
| **Rig bubble** | Large rounded container. Header shows name, health pills (°C, load, cam ✓), and a heartbeat dot. Turns grey with a dashed border when offline |
| **Device bubble** | Circle containing a **live cropped camera thumbnail** of that board (snapshot refresh 1 s, or MJPEG when selected). Border = status: free = thin neutral, leased = thick in the holder session's colour, resetting = spinning dashed, offline = grey with a strike |
| **Camera bubble** | Small lens icon; while verifying it emits a scan arc toward the device being checked |
| `attached` edge | Short, thin, solid neutral line from rig to device (physical USB). Always present |
| `watches` edge | Faint dotted line from camera to each calibrated device; brightens during a verify |
| `lease` edge | **Thick solid line in the session's colour** from session to device, with animated particles flowing *down* while a run/verify is active. Label: `tok 17 · 3:12` (fencing token, time left) |
| `queue` edge | **Dashed line**, same session colour at 50 % opacity, with a numbered badge `#1`, `#2` at the device end. Waiting sessions visibly "line up" |
| Verdict | When a verify lands, the device bubble flashes a ring: green ✓ (camera-confirmed) or red ✗, and a toast shows `led_sequence ✗ step 2: LED 0 still on`. Self-reported checks flash amber, never green |
| Hand-over | On release: the lease edge retracts upward, the device goes "resetting", then "idle confirmed" (small camera tick), then the #1 queue edge solidifies into a lease. This is the money animation for "safe sharing" |

**Session colours:** assign each session a hue from a fixed 8-colour palette chosen to avoid pure blue (the Uno Q matrix is blue), green and red (reserved for verdicts). Colour ties a session to its edges and leased devices at a glance.

## 5. Interactions

- **Hover** any bubble: tooltip with its key facts. Hover an edge: lease/queue detail.
- **Click a session** → right drawer:
  - header: title, Devin status, ACUs, link to the Devin session;
  - leases and queue positions;
  - the last 20 messages (live);
  - **prompt box**: Enter sends `POST /api/sessions/{id}/message`;
  - Stop button (confirm dialog).
- **Click a device** → right drawer:
  - live MJPEG crop;
  - holder, token, expiry, queue list;
  - current run state + log tail;
  - the last verdict with the expected-vs-measured table and a link to evidence;
  - **Poll** button (`POST .../poll`: fresh health + snapshot);
  - team-only Reset / Revoke.
- **Click a rig** → drawer with health history sparkline (temp, load) and a maintenance toggle.
- **"+ New session"** (top-right) → modal:
  - pick a ticket;
  - optional device hint, extra prompt, ACU cap;
  - shows remaining ACU budget.
  - Creating one makes a new session bubble appear immediately in "joining" (hollow ring). It fills when its tailnet node comes online.
- **Command bar (⌘K):** jump to a node, run "poll all", toggle replay.
- **Timeline scrubber** (bottom): last 30 min of events. Dragging it replays the graph state (the same reducer over buffered events), which is also how replay mode works.

## 6. Public vs operator

| | Operator (tailnet) | Public (Funnel) |
|---|---|---|
| Map, live thumbnails, verdicts | ✓ | ✓ |
| Session titles | ✓ | ✓ (ticket name only) |
| Messages / transcripts | ✓ | ✗ |
| Prompt, new session, stop, reset, revoke, poll | ✓ | ✗ (poll is rate-limited read-only snapshot) |
| Evidence pages | ✓ | ✓ |

The public build is the same app with `VITE_PUBLIC=1`, which tree-shakes the mutating controls.

## 7. Visual design

- **Theme:** dark "night lab", near-black blue-grey background (#0B0F14), faint dot grid that fades at the edges, so the canvas reads as space.
- **Type:** Inter Tight / Söhne-like grotesk for labels; JetBrains Mono (tabular) for every number, token, timer and measurement. Measurements always show units and `±`.
- **Colour semantics, never reused:** green = confirmed by camera, red = contradicted by camera, amber = self-reported/degraded/waiting, grey = offline. Session hues are drawn from a separate palette.
- **Motion:** only meaningful transitions animate (lease, queue advance, verdict, hand-over). Edge particles run only during active work. Respect `prefers-reduced-motion` (no particles, instant transitions).
- **Video legibility:** test at 1080p with 50 % zoom; labels ≥ 13 px; bubble thumbnails ≥ 96 px; nothing important in the outer 5 % (YouTube/Devpost players crop).
- **Badges:** a permanent `LIVE` (pulsing) or `REPLAY` badge top-left; `MOCK` when on fixtures. A "reconnecting…" banner on SSE loss, keeping the last known graph greyed.

## 8. Replay and mock

- `?mock=1`: fixture graph + scripted event file (`web/fixtures/*.ndjson`) that tells the whole demo story: three sessions, one queued, one verdict ✗, fix, ✓, hand-over.
- `?replay=<file>`: plays a recording captured from control (`farm-control record --out run.ndjson`). Always badged REPLAY.
- Control records every event to `var/events-YYYYMMDD.ndjson` so any real run can become a replay.

## 9. Acceptance

- Mock mode runs with zero backend.
- 3 sessions, 2 rigs, 5 devices render at 60 fps on a laptop.
- An event shows on screen < 300 ms after arriving.
- Losing the SSE connection never blanks the screen.
- A reviewer can tell from a 3-second screenshot which session holds which board and who is waiting.
