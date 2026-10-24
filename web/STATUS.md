# web/ status (Lane D)

| Area | State |
|---|---|
| Dashboard (sidebar, sessions, hardware cards, activity timeline), desktop + phone | works on mock data; live untested (no farm-control yet) |
| Bubble graph (FRONTEND.md map) | works on mock data, kept at `?view=graph` |
| Drawers (session / device / rig / camera), new session, ⌘K, toasts | works on mock; mutating calls untested against control |
| Mock / replay player, demo fixture, timeline scrub | works (`?mock=1`, `?replay=<name>`, `?speed=N`) |
| Evidence page (`evidence.html`, served at `/e/<id>`) | works on sample bundles (`/evidence.html?fixture=1`) |
| Story docs (`docs/pitch/`, `docs/media/architecture.svg`) | first drafts; E1 numbers TODO |

**Needs from Lane C (contract gaps):**
- C4 `lease` granted/renewed should carry `token` and `expires_at` (UI shows `tok 17 · 3:12 left`).
- An explicit "idle confirmed" signal (today: device `resetting` → `free`).
- How a rig goes offline (control sets rig node `status: "offline"`, or a heartbeat timeout).
- `GET /api/tickets` (UI falls back to a static list); C7 `frames` list + `sample` flag.
- Device `data.type` / `data.order` on graph nodes (board drawing + bench order).

**Open design decision:** the dashboard uses green for "Running" (per the reference design), which FRONTEND §7 reserved for camera verdicts; verdicts carry ✓/✗ chips to stay distinct.

Run: `cd web && npm ci && npm run dev` then open `http://localhost:5173/?mock=1`.
