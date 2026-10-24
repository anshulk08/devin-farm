# Judge Q&A crib

Expands `docs/SUBMISSION.md` §5. Answers are short enough to say in 20 seconds. Each one points to where the claim is backed up, so whoever answers can open it on screen. If the honest answer is "we didn't get to it", say that.

## The four from SUBMISSION §5

**Why not Devin Outposts?**
Outposts runs Devin on your own machines, several at once, and gives each one a shell. We give a session a lease on one board, with a queue and a fencing token across many sessions, no shell on the rig, and a verdict from a camera the agent can't reach. (SCOPE §7)

**Can the agent fake the verdict?**
It has no network path to the verifier: the policy opens only rig port 8080 to sessions, and the verifier listens on 127.0.0.1. Assertions are data, the camera is physical, and reset is camera-confirmed. Limits: an agent could light *extra* LEDs on its own board, and camera resolution caps what we can measure. (CONTRACTS C0, C5)

**What if the agent writes malicious code?**
It only runs on the target board, never on the Jetson. USB is allowlisted so a board can't re-enumerate as a keyboard, and boards are wiped on reset. This is hackathon-grade; `rig/SECURITY.md` lists what's left. (SCOPE §5.2, §7)

**Does it scale?**
Locks are per rig, so adding rigs adds capacity without shared state, and control finds new rigs by tag. Cross-rig "any free Pico" scheduling is next. (SCOPE §7)

## Ten more

**1. What if a Devin VM can't run Tailscale?**
That was our first Day-0 check (G1). In a VM without a TUN device, `tailscaled` runs in userspace mode with a local HTTP proxy, and the `farm` CLI routes through it. If that had failed, the documented fallback was control proxying the rig API over Funnel with per-session bearer tokens. Same lease API, weaker identity story. TODO: say which one we ran. (SCOPE §7, §8)

**2. What stops one agent holding a board forever?**
A lease lasts 300 s, renews on activity, and has a hard cap of 1800 s from grant. It also ends if the session's tailnet node disappears for 30 s, or if a team member revokes it. Queued requests that stop polling for 30 s are dropped. (CONTRACTS C2)

**3. What is the fencing token for?**
It's a counter per board that goes up on every grant and is persisted. Every lease-scoped call must present it and come from the holder's node. If a session's lease expired and someone else got the board, the old session's late "run" call carries a stale token and gets a 403. (CONTRACTS C1, C2)

**4. What happens if the reset fails?**
The board doesn't get handed over. The verifier has 10 s to see the idle pattern; if it doesn't, the board goes offline with a reason, the queue stays where it is, and the map flags it to the team. We'd rather stall than give the next agent a dirty board. (CONTRACTS C2, C8)

**5. How precise is the camera?**
Every result carries its uncertainty. For LED timing, the floor is one frame period, so at TODO fps it's about TODO ms, and the tolerance can't be set tighter than that. Near the frame-rate limit the verifier reports "can't verify" instead of guessing. If a board isn't visible (uncalibrated, camera down, drift), the result is a fail with that reason, never a pass. (CONTRACTS C6, `verifier/ASSERTIONS.md`)

**6. Some checks are just "the log says READY". Isn't that the same as trusting the agent?**
Yes, and we label it that way. `log_contains` is evaluated over the run's logs, always comes back marked self-reported, and the map shows it in amber, never green. Only camera results can be green. (CONTRACTS C6, FRONTEND §7)

**7. How did you measure "claimed vs confirmed"?**
Two arms, with and without the farm, on the same tickets including trap variants, three reps each. The agent's claim comes from Devin's structured output. A separate grader re-runs each final commit on the rig with hidden assertions the agent never saw, and we report counts with 95 % Wilson intervals. The plan is written down in `experiments/PLAN.md` before the first run (TODO: confirm the commit predates the first E1 run). Results: TODO (E1). (`experiments/PLAN.md`)

**8. Aren't the trap tickets rigged against the agent?**
The trap is ordinary wiring: external LEDs active-low or on non-tutorial pins, or Uno Q timing that only the microcontroller can meet. TODO: confirm with A that the board's describe page documents the wiring. An agent that reads the board description and verifies passes; one that assumes the tutorial wiring and trusts its logs fails. That gap is the point. (WORKSPLIT Lane A §8)

**9. Why one lock per board and not per rig?**
Because the boards are independent. Two sessions can work on the Pico and the Uno Q on the same rig at the same time; only the second request for the *same* board waits. A node can hold at most two leases per rig so one agent can't take everything. (CONTRACTS C2)

**10. The camera is in a room. What about privacy?**
The verifier crops to each board's region at the source and never serves the full frame. The public view shows those crops and the evidence clips, nothing else: no room, no transcripts. (SCOPE §5.2)

**11. How do you keep cost under control with many agents?**
Every session is created with an ACU cap, and control keeps a global ACU budget and refuses to create sessions past it. The map shows the remaining budget when you start one. (SCOPE §5.2, CONTRACTS C10)

**12. What in this demo is live?**
The badge in the top-left says so: LIVE, REPLAY or MOCK. Replays are recordings of real runs from control's event log. In the video, sped-up footage says so on screen. We never show a mock as live. (FRONTEND §7, §8)

**13. How does Devin actually use it? Is this just a script?**
The Devin session does the work: it reads the board description, writes the code, leases the board, runs, asks for a check, reads the measured result, fixes and repeats, then opens the PR with the evidence link. We give it a playbook and a small CLI; control creates sessions through the Devin API with the join key as a session secret and reads back a structured claim. (WORKSPLIT Lane C §3, §4)

**14. Why not a simulator?**
A simulator shares the agent's assumptions: if the agent thinks the LED is on GP16, so does the model of the board it writes or picks. The traps are exactly the cases where reality and the assumption differ. A camera on the real board doesn't share any assumptions.
