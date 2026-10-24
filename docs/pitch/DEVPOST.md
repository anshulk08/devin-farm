# Devpost draft

First draft, owner D. Anything marked **TODO** needs a real value before submission. We don't round up, estimate or invent results; if a number isn't measured, the sentence goes.

**Title:** Devin Farm

**Tagline (≤ 60 chars):** Cloud agents share real boards. A camera checks their work.

---

## Inspiration

Coding agents are good at writing embedded code and bad at knowing whether it worked. They read their own logs, see no errors, and report "done". On real hardware that's often wrong: an LED on the wrong pin, a polarity flipped, timing that only looks right in a print statement. We wanted the board itself to have the last word.

Two things were missing. Agents need a way to share a small number of real boards without stepping on each other or getting a shell on the machine the boards are plugged into. And the check of whether the code worked has to come from something the agent can't touch.

## What it does

Devin Farm is a hardware lab that cloud Devin sessions can use over a private network.

- **Rigs** (a Jetson with a Raspberry Pi Pico, an Arduino Uno Q and a camera) join a Tailscale tailnet. Each Devin session joins the same tailnet with a one-off, short-lived identity. The network policy lets a session reach one port on a rig and nothing else.
- A session **leases a single board**. One lease per board; anyone else asking is queued in order and sees their position. Every lease carries a fencing token, so a session whose lease has expired can't keep writing to the board.
- The session **deploys code by git SHA** and asks for a **check**: "LEDs 0 and 2 for 500 ms, then LED 1", or "this 8×13 image on the matrix". The verifier watches the board through a fixed camera and returns what it **measured**, with units and an error bar. The agent reads the measurement, fixes its code, and tries again.
- When a session lets go, the rig **wipes the board, runs a known idle pattern, and the camera confirms it** before the next session in the queue gets the board.
- Each check produces an **evidence bundle** (clip, key frames, results, commit) at a public, unguessable URL that the agent links in its pull request.
- A **live bubble map** shows every session, rig, board and camera, and every lease and queue line between them. From the map, an operator can poll hardware, read session status and messages, prompt any session, and start new ones. A read-only version is public, so judges and PR reviewers can watch without being on our network.

## How we built it

- **Network and identity:** Tailscale. Rigs are `tag:rig`, the control plane is `tag:control`, sessions are `tag:devin-session`. The policy file grants sessions `tcp:8080` on rigs only; sessions can't reach each other, the control plane, rig SSH, the rig admin port or the verifier. The control plane mints a one-off, ephemeral, pre-authorized key per session through a Tailscale OAuth client and hands it to the session as a secret. The rig identifies every caller with `tailscale whois`, so there are no API keys to leak. In a Devin VM without a TUN device, `tailscaled` runs in userspace mode with a local HTTP proxy. TODO: confirm which join mode we actually ran (Day-0 check G1).
- **Rig daemon (`farm-rigd`):** Python, FastAPI and SQLite. It owns leases, FIFO queues and fencing tokens for its own boards, deploys by SHA (shallow clone, hooks off, path and size checks), and never runs agent code on the Jetson itself. Pico code goes on with `mpremote`; Uno Q apps with `arduino-app-cli`. USB is allowlisted with usbguard so a board can't re-enumerate as a keyboard.
- **Verifier (`farm-verifier`):** Python, OpenCV and numpy, listening on localhost only. It calibrates regions of interest from each board's idle pattern, then measures LED sequences (per step: which LEDs, how long) and matrix frames (8×13 cells after a homography). Each result has measured, expected, uncertainty and a plain-language detail. It writes a clip with a burned-in overlay.
- **Control plane (`farm-control`):** TODO (language, decided at T+1). It discovers rigs by tag, merges their event streams into one graph, drives sessions through the Devin API v3 (create with session secrets, a playbook, an ACU cap and a structured-output schema; poll; message; archive), republishes evidence, and serves the map: operator view over `tailscale serve`, public view over Funnel.
- **Map:** React, Vite and TypeScript with React Flow and d3-force, fed by server-sent events into one reducer. The same reducer runs over recorded events, which gives us replay mode and a timeline scrubber.
- **Session kit:** a join script, a small `farm` CLI over curl, and a Devin playbook that tells the agent to verify before it claims anything.
- **Experiment (E1):** the same tickets with and without the farm, three reps each. The agent's claim comes from structured output; an independent grader re-runs each final commit on the rig with hidden assertions.

## Challenges we ran into

- TODO (fill from `docs/pitch/REHEARSAL.md` and lane STATUS files; candidates below, keep only what actually happened).
- Getting a cloud VM onto a tailnet without kernel networking, and making every agent tool call go through the userspace proxy.
- Making hand-over safe: a board isn't free until it's been reset and the camera has seen the idle pattern, and when that fails the board goes offline instead of being handed to the next session.
- Camera measurement at the edge of the frame rate: deciding when the verifier must say "can't verify" instead of guessing.
- Keeping the map stable: positions pinned after the first layout so the picture doesn't reshuffle on every event.

## Accomplishments that we're proud of

- TODO (confirm each before submission): several Devin sessions sharing one rig at the same time, one lease per board, with a visible queue.
- TODO: a real hand-over: release, reset, idle confirmed by camera, next session granted.
- TODO: a real pull request from a Devin session with camera evidence attached (link).
- TODO (E1): out of TODO runs without the farm, agents claimed success TODO times and the camera confirmed TODO; with the farm, TODO claimed and TODO confirmed (95 % Wilson intervals in `experiments/results/`).

## What we learned

- TODO (write after E1 and rehearsals). Draft points to confirm or drop:
- Independent verification changes agent behaviour only if the result is specific. "Step 2: LED 0 still on" gets fixed; "failed" gets retried.
- Network identity is a cleaner access model for agents than API keys: the policy file holds most of the access story, and it's short.
- Locks belong with the thing that can reset the hardware, not in a central service.

## What's next

- Scheduling across rigs ("any free Pico") on top of per-rig locks.
- More assertion types (RGB colour, scrolling text, blink rate) and more board types.
- A GPU lane on the Jetson for agents that need to run models on the device, with the same lease and evidence model.
- Running the experiment against other agent setups, including Devin Outposts.

## Built with

Devin (API v3, playbooks, structured output) · Tailscale (ACL grants, OAuth-minted ephemeral keys, `whois`, userspace networking, Serve, Funnel) · NVIDIA Jetson · Raspberry Pi Pico (MicroPython, mpremote) · Arduino Uno Q (arduino-app-cli) · Python · FastAPI · SQLite · OpenCV · numpy · React · Vite · TypeScript · React Flow · d3-force · GitHub API · systemd · usbguard

TODO: confirm the list against what's in `main` at `v1.0` (drop anything we didn't ship).

## Links

- Live map: TODO
- Demo video: TODO
- Repo: https://github.com/anshulk08/devin-farm
- Example evidence page: TODO
- Example pull request: TODO
