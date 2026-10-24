# Devin Farm kit (rig edition)

Five ready-to-paste prompts for coding agents, plus the shared contracts and a design note.

| File | Who uses it | What it is |
|---|---|---|
| `prompts/00-verification.md` | one person, first hour | Agent 0: settles the unknowns (Jetson as hub, USB transports, sandbox, Devin API, Outposts) in 60 minutes |
| `prompts/01-broker-devin.md` | Person 1 | Cloud broker, leases, Devin-side tooling, CONTRACTS owner |
| `prompts/02-node-rig.md` | Person 2 (hands on the rig) | Node agent, drivers, rig provisioning, sandbox |
| `prompts/03-observer-oracle.md` | Person 3 (hands on the rig) | Camera observer, assertions, benchmark harness, enclosure spec |
| `prompts/04-story.md` | Person 4 | Tickets, dashboard, experiments, demo and pitch |
| `docs/CONTRACTS.md` | everyone | Interface contracts v0.2 (already pasted into every prompt) |
| `RIG_DESIGN.md` | humans | Why the Jetson is the rig, what it costs, fallbacks |
| `docs/CONCEPT.md` | humans | The fleshed-out idea: personas, scope tiers, dashboard UI/design, research findings, open decisions |

Each prompt already contains the shared context and the contracts, so each agent can start from a single paste.

## Setup in the first 15 minutes (humans)
1. Create one Git repo (monorepo). Put `docs/CONTRACTS.md` from this kit in it and push to `main`. Create branches `dir1-broker`, `dir2-node`, `dir3-observer`, `dir4-story`.
2. Give the Jetson Ethernet and power, install Tailscale on it (see below), and add all four teammates to the tailnet. Directions 2 and 3 must be physically near the rig.
3. Start Agent 0 immediately, in parallel with the other four. Its report (`docs/VERIFICATION_REPORT.md`) lands in about an hour; paste its "Decisions" box to everyone and let Direction 1 apply any contract changes.
4. Paste prompts 01 to 04 into each person's coding agent, in the repo checkout. Each agent works only in its own directories.
5. Collect secrets in a password manager, never in the repo: `FARM_API_KEY`, `FARM_DEMO_KEY`, `FARM_ADMIN_TOKEN`, `NODE_TOKEN`, `OBSERVER_TOKEN` (generate random strings), `DEVIN_API_KEY` (a `cog_` service-user key), optionally `GITHUB_TOKEN`.

## Who owns what (no overlap)
| Path | Owner |
|---|---|
| `broker/`, `devin/`, `docs/CONTRACTS.md` | 1 |
| `node/`, `rig/` | 2 |
| `observer/` (incl. `jetson_bench`, enclosure docs) | 3 |
| `tickets/`, `dashboard/`, `experiments/`, `docs/pitch/` | 4 |
| `spike/`, `docs/VERIFICATION_REPORT.md`, `docs/verification.json` | 0 |

Shared touch points, all through contracts and never by editing each other's files: the WebSocket messages (1-2, 1-3), the ticket format (2-4), the assertion DSL (3-4), the SSE stream (1-4), the idle patterns (2-3), the sandbox runner used by the bench harness (2-3).

## Checkpoints
- T+1: rig provisioned and reachable; Jetson facts published; camera mounted.
- T+2: contracts v1.0 frozen; everyone says hello over their interface using mocks.
- T+6: first end-to-end on the Uno Q through the real broker URL.
- T+12: all three lanes; sandbox escape tests green or the Jetson lane is cut (see `RIG_DESIGN.md`).
- T+16: feature freeze.
- T+21: rehearsal with three live Devin sessions; backup replay recorded; two-hour soak complete.

## Things the humans must decide or do (agents cannot)
- Flash or confirm the Jetson's JetPack and check which model it is (original Nano or Orin Nano) before anything else.
- Build the enclosure (matte dark box, constant LED light, rigid camera mount). Direction 3 specifies it.
- Run the `sudo` provisioning scripts Direction 2 writes.
- Create the Devin service user, API key and any MCP/Outposts steps Agent 0 marks `NEEDS HUMAN`.
- Decide the ACU budget for experiments (Agent 0 will recommend a cap).
- Film the demo.

## Tailscale in one paragraph
On the Jetson: install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up --hostname=rig-1`), and invite teammates to the tailnet. Then `ssh farm@rig-1` works from anywhere with each person's own key. If Tailscale does not install on the Jetson's OS, use a reverse SSH tunnel through a cheap VPS instead and tell Direction 2.

## If something is on fire
- Rig acting strange during a session: `POST /v1/admin/maintenance {"on": true}`, wait for leases to drain, then `reset_all`.
- Everything is broken one hour before the demo: use the recorded replay (it is labelled as a replay) and show the dashboard in mock mode.
