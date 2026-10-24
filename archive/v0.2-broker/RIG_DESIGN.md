# Rig design note: the Jetson as an always-on lab

This is for the humans, not the agents. It records what the "Jetson is the rig" idea buys us, what it costs, the decisions I made, and the fallbacks.

## The idea
A Jetson lives in a box at a fixed place. The Uno Q and Pico plug into it, a webcam watches them, and it holds an outbound connection to a cloud broker at all times. Cloud Devin sessions never touch the machine; they lease devices through the broker. No laptop sits between the cloud and the hardware.

## Verdict
Do it, but treat it as a more serious system, not a relocation. It is stronger than the laptop hub for three reasons and weaker for four. The weaknesses are all manageable if the decisions below are followed.

### What it buys
1. **It is a product, not a demo setup.** "A lab on the internet that is always on" is a cleaner story than "a laptop with cables". Judges can be given a link that shows the rig live.
2. **Demo robustness.** No presenter laptop to forget, sleep or reboot. The broker stays up when the rig drops, so you get a graceful "offline" instead of a dead URL.
3. **Remote development on real hardware.** Two of four teammates (broker, story) no longer need to be in the room. They lease devices like any agent. This probably saves more hours than any other benefit.
4. **Constant conditions.** A light-controlled enclosure makes camera verification much more reliable than a webcam on a desk next to a window.

### What it costs
1. **The Jetson can't be both hub and an untrusted test device.** If agent code runs on the same machine as the node and the camera, the agent can reach the verifier. Decision: the Jetson lane runs agent code only inside a locked-down container (no network, no camera, no mounts, no GPIO), and the status LED for that lane is driven by trusted node code. This is hackathon-grade isolation (shared kernel), documented as such, with escape tests that must pass before the lane is used in the demo.
2. **Benchmark integrity.** Camera CV and benchmarking compete for the same cores and thermal budget. Decision: the broker puts the observer into `quiet` mode around a bench; the result records temperature, throttling and load, so a disturbed run is visible rather than silently wrong.
3. **The Nano may be too small.** If it is the original Nano (4 GB, JetPack 4.x, Python 3.6), node + observer + sandbox is tight, and modern libraries need a newer Python. Decisions: resource budgets are written into the rules, services run in a Python >= 3.8 environment, and the verification agent measures all this in the first hour (R1-R3). If the numbers don't fit, the fallback is to keep the observer on a laptop with the camera and leave the Jetson as node + lane (the contracts allow this: the observer is already a separate outbound WebSocket client).
4. **A permanent attack surface.** An internet-reachable lab with a network-connected Linux board is something you must defend. Decisions: the rig has no inbound ports; the broker is the only public surface with rate limits and an admin kill switch; the Uno Q has no route to the home network (USB only, WiFi forgotten); only a cropped device view is ever public.

## How close is this to Outposts, honestly
Very close in topology: both are "a dedicated always-on machine with peripherals that a cloud session reaches". If you ran `devin worker start` on this Jetson, a Devin session would get a shell next to the same boards. Any pitch that says "we give Devin access to hardware" is therefore weak, and is already covered by Devin's own features.

What is still genuinely different, in descending order of how much I would lean on it:
1. **Independent verification.** The agent cannot see or alter the camera or the benchmark harness. With a shell on the rig it could. This is also what the E1 experiment measures: how often an agent's "it works" is contradicted by the camera.
2. **The trust boundary.** The session has no shell on the rig; code reaches a board by git reference and runs only on the board or in the sandbox. An Outpost shell can do anything, including flash the wrong device or break the rig for everyone.
3. **Per-device leases, fencing, queue, safe reset.** Three sessions share one rig with scoped access and automatic recovery. Outposts (documented) allow one session per machine while active.
4. **Works where Outposts and Local Hands may not**: service-user/automation/scheduled sessions, and agents that are not Devin. (Verify the Outposts and Local Hands details in the verification report before saying this out loud.)
5. **Evidence in the PR.** Measured results and a clip attached to the pull request.

Practical consequence: add an `outpost` arm to experiment E1 if the verification agent confirms an Outpost worker runs on the Jetson and an API session can target it. "Agent with a shell on the rig and no verification" versus "agent with Farm" on the same boards is the most honest head-to-head available, and it turns the closeness to Outposts into a feature of the evaluation.

## Resolving "a cloud session can lock in on it at all times"
Two readings, two answers:
- **The rig is always connected**: yes. It holds an outbound WebSocket to the broker, reconnects on failure, and its devices show as `offline` when it is gone.
- **A session holds a device permanently**: no. Leases renew on activity up to a 30-minute cap, with a demo priority key. A permanent lock would let one stuck session block everyone and would erase the sharing story. E2/E3 are designed to show why short per-call leases beat holding a machine.

## The third lane (jetson-1)
Previously the Jetson was a board under test. Now it is also the host, so the lane is "the rig, sandboxed": GPU code in a container, verified by the bench harness, visible as a status LED. It is the most likely thing to be cut. Decision rule: if the sandbox escape tests are not green by T+12, run the demo with two camera-verified boards plus the live rig-health view, and keep the Jetson lane in a recorded segment labelled as such. Don't ship an unsafe lane to keep the number three.

## Risks to watch (in rough order of likelihood)
1. Uno Q transport from the Jetson (adb on aarch64, or ssh over USB) doesn't work. Tested in R2; fallback is a small Linux box or the laptop as a USB bridge for the Uno Q only.
2. Observer CPU cost or thermal throttling on the Nano. Tested in R2; fallback above.
3. Venue or home network blocks outbound WebSockets. Fallback: phone hotspot or cloudflared; documented in `rig/NETWORK.md`.
4. Lighting or camera drift. Mitigated by the enclosure; drift check before each observe.
5. Single point of failure at demo time. Mitigated by the maintenance toggle, a recorded replay, and a 2-hour soak test before the freeze.
6. Devin can't reach the broker or can't read evidence (network policy). Tested in V3.

## Human roles this implies
Two people need hands on the rig early (Directions 2 and 3: provisioning, wiring, enclosure, camera, lighting). Directions 1 and 4 can work from anywhere against mocks and then the live rig. Make sure whoever owns the rig is physically near it, and give everyone Tailscale access in the first hour.

## Decisions I made that you may want to veto
- Broker stays in the cloud rather than on the Jetson (survives rig outages, gives a stable URL).
- Node and observer stay separate processes even though they now share a machine (keeps the four directions independent; costs a little memory).
- Uno Q is connected by USB only, with no network, even though that makes `pip install` on it impossible (requirements are pre-installed and allowlisted).
- The Jetson lane is bench-only, no camera assertions, and the first thing we cut.
