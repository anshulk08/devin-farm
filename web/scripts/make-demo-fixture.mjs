#!/usr/bin/env node
// Generates web/public/fixtures/demo.ndjson: the scripted demo story for ?mock=1 (FRONTEND §8).
//
//   node web/scripts/make-demo-fixture.mjs            # writes the fixture
//   node web/scripts/make-demo-fixture.mjs --stdout   # prints it instead
//
// Topology and IDs match web/src/data/sampleGraph.ts exactly (3 sessions, 2 rigs, 5 devices, T0 = 1761300000).
// The snapshot starts with hardware only; sessions join via `session` events so the map fills up on screen.
//
// Story (fixture seconds from T0):
//   0    snapshot: rig-1 (pico-1, unoq-1, pico-3, camera), rig-2 mock (pico-2, unoq-2 offline, camera)
//   2    s-1a2b3c4d joins, leases pico-1 (token 17), builds, runs
//   8    s-5e6f7a8b joins, leases unoq-1 (token 4)
//   14   s-9c0d1e2f joins, pico-1 is taken: queued #1
//   22   pico-1 verify FAILS (led_sequence step 2: LED 0 still on), Devin explains, user nudges
//   30   unoq-1 matrix_frame PASS + evidence
//   38   s-1a2b3c4d re-flashes the fix; s-5e6f7a8b checks READY on rig-2/pico-2 (log_contains, self-reported)
//   50   pico-1 verify PASS + evidence
//   60   hand-over: pico-1 released → resetting → free (idle confirmed) → s-9c0d1e2f granted token 18
//   70   s-9c0d1e2f run + verify PASS; s-5e6f7a8b finishes and releases unoq-1
//   ~110 end
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const T0 = 1_761_300_000;
const END = 112;

const S = {
  a: { farm_id: "s-1a2b3c4d", title: "pico/led-sequence-trap", url: "https://app.devin.ai/sessions/demo-a", devin: "devin-demo-a" },
  b: { farm_id: "s-5e6f7a8b", title: "unoq/matrix-heart", url: "https://app.devin.ai/sessions/demo-b", devin: "devin-demo-b" },
  c: { farm_id: "s-9c0d1e2f", title: "pico/led-sequence", url: "https://app.devin.ai/sessions/demo-c", devin: "devin-demo-c" },
};
const holder = (s) => `devin-${s.farm_id}`;

// ---- snapshot: hardware only (sessions and leases arrive as events) ----
const snapshot = {
  nodes: [
    { id: "rig:rig-1", kind: "rig", label: "rig-1", status: "online", data: { model: "Jetson Orin Nano", temp_c: 47.8, load1: 0.41, mem_free_mb: 2310, throttled: false, camera_ok: true, verifier_online: true, maintenance: false } },
    { id: "device:rig-1/pico-1", kind: "device", parent: "rig:rig-1", label: "pico-1", status: "free", data: { type: "pico", order: 0, queue_depth: 0, outputs: ["pico.leds"] } },
    { id: "device:rig-1/unoq-1", kind: "device", parent: "rig:rig-1", label: "unoq-1", status: "free", data: { type: "unoq", order: 1, queue_depth: 0, outputs: ["unoq.matrix", "unoq.rgb1"] } },
    { id: "device:rig-1/pico-3", kind: "device", parent: "rig:rig-1", label: "pico-3", status: "free", data: { type: "pico", order: 2, queue_depth: 0, outputs: ["pico.leds"] } },
    { id: "camera:rig-1", kind: "camera", parent: "rig:rig-1", label: "cam0", status: "ok", data: { fps: 30 } },

    { id: "rig:rig-2", kind: "rig", label: "rig-2", status: "online", data: { model: "mock", mock: true, temp_c: 41.0, load1: 0.1, mem_free_mb: 6000, throttled: false, camera_ok: true, verifier_online: true, maintenance: false } },
    { id: "device:rig-2/pico-2", kind: "device", parent: "rig:rig-2", label: "pico-2", status: "free", data: { type: "pico", order: 0, queue_depth: 0, outputs: ["pico.leds"] } },
    { id: "device:rig-2/unoq-2", kind: "device", parent: "rig:rig-2", label: "unoq-2", status: "offline", data: { type: "unoq", order: 1, queue_depth: 0, reason: "idle not confirmed" } },
    { id: "camera:rig-2", kind: "camera", parent: "rig:rig-2", label: "cam0", status: "ok", data: { fps: 30 } },
  ],
  edges: [
    { id: "attached:rig-1/pico-1", kind: "attached", source: "rig:rig-1", target: "device:rig-1/pico-1" },
    { id: "attached:rig-1/unoq-1", kind: "attached", source: "rig:rig-1", target: "device:rig-1/unoq-1" },
    { id: "attached:rig-1/pico-3", kind: "attached", source: "rig:rig-1", target: "device:rig-1/pico-3" },
    { id: "attached:rig-2/pico-2", kind: "attached", source: "rig:rig-2", target: "device:rig-2/pico-2" },
    { id: "attached:rig-2/unoq-2", kind: "attached", source: "rig:rig-2", target: "device:rig-2/unoq-2" },
    { id: "watches:rig-1/pico-1", kind: "watches", source: "camera:rig-1", target: "device:rig-1/pico-1" },
    { id: "watches:rig-1/unoq-1", kind: "watches", source: "camera:rig-1", target: "device:rig-1/unoq-1" },
    { id: "watches:rig-1/pico-3", kind: "watches", source: "camera:rig-1", target: "device:rig-1/pico-3" },
    { id: "watches:rig-2/pico-2", kind: "watches", source: "camera:rig-2", target: "device:rig-2/pico-2" },
  ],
};

// ---- event builder ----
const out = [];
let seq = 0;
const at = (t, name, data) => out.push({ t, seq: seq++, ev: { name, data: { ...data, ts: +(T0 + t).toFixed(2) } } });

const session = (t, s, status, acus) =>
  at(t, "session", { farm_id: s.farm_id, devin_session_id: s.devin, node_name: status === "joining" ? undefined : holder(s), status, acus, title: s.title, url: s.url });
const say = (t, s, source, text) => at(t, "session_message", { farm_id: s.farm_id, source, text });
const device = (t, rig_id, dev, status, h, queue_depth) => at(t, "device", { rig_id, device: dev, status, ...(h ? { holder: h } : {}), queue_depth });
const lease = (t, rig_id, dev, lease_id, s, event, extra = {}) => at(t, "lease", { rig_id, device: dev, lease_id, holder: holder(s), event, ...extra });
const run = (t, rig_id, dev, run_id, state) => at(t, "run", { rig_id, device: dev, run_id, state });
const log = (t, rig_id, dev, run_id, lines, every = 0.4) => lines.forEach((text, i) => at(t + i * every, "log", { rig_id, device: dev, run_id, text }));
const verify = (t, rig_id, dev, verify_id, state, results) => at(t, "verify", { rig_id, device: dev, verify_id, state, ...(results ? { results } : {}) });
const evidence = (t, rig_id, dev, evidence_id, passed) => at(t, "evidence", { rig_id, device: dev, evidence_id, passed });

// ---- assertions (C6) ----
const LED_EXPECTED = { steps: [{ on: [0, 2], ms: 500 }, { on: [1], ms: 500 }], repeat: 3, tol_ms: 80 };
const ledFail = {
  type: "led_sequence",
  target: "pico.leds",
  passed: false,
  measured: { steps: [{ on: [0, 2], ms: 498 }, { on: [0, 1], ms: 503 }] },
  expected: LED_EXPECTED,
  uncertainty: { ms: 33 },
  detail: "step 2: LED 0 still on (expected only LED 1)",
  self_reported: false,
};
const ledPass = (ms1, ms2) => ({
  type: "led_sequence",
  target: "pico.leds",
  passed: true,
  measured: { steps: [{ on: [0, 2], ms: ms1 }, { on: [1], ms: ms2 }], repeats_matched: 3 },
  expected: LED_EXPECTED,
  uncertainty: { ms: 33 },
  detail: "3 of 3 repeats matched within ±80 ms",
  self_reported: false,
});
const HEART = [
  ".............",
  "...##...##...",
  "..####.####..",
  "..#########..",
  "...#######...",
  "....#####....",
  ".....###.....",
  "......#......",
];
const matrixPass = {
  type: "matrix_frame",
  target: "unoq.matrix",
  passed: true,
  measured: { ascii: HEART, mismatched_cells: 1, held_s: 2.4 },
  expected: { ascii: HEART, tol_cells: 2, hold_s: 2 },
  uncertainty: { cells: 1, s: 0.033 },
  detail: "1 cell off (tolerance 2), held 2.4 s",
  self_reported: false,
};
const readySelf = {
  type: "log_contains",
  passed: true,
  measured: { line: "READY", line_no: 9 },
  expected: { pattern: "READY" },
  detail: "matched in run log line 9 (not checked by camera)",
  self_reported: true,
};

// ---- rig health every 5 s; rig-1 warms up while building ----
for (let t = 0; t <= END; t += 5) {
  const busy = (t >= 10 && t <= 30) || (t >= 38 && t <= 56) || (t >= 70 && t <= 88);
  const temp = 47.8 + (busy ? 6 : 0) * Math.min(1, ((t % 20) + 5) / 20) + Math.sin(t / 7) * 0.6;
  const load = (busy ? 2.1 : 0.45) + Math.cos(t / 5) * 0.15;
  at(t, "rig_health", { rig_id: "rig-1", temp_c: +temp.toFixed(1), load1: +load.toFixed(2), mem_free_mb: busy ? 1640 : 2290, throttled: false, camera_ok: true, verifier_online: true });
  at(t + 0.5, "rig_health", { rig_id: "rig-2", temp_c: +(41 + Math.sin(t / 9) * 0.4).toFixed(1), load1: +(0.1 + (t >= 40 && t <= 50 ? 0.6 : 0)).toFixed(2), mem_free_mb: 6000, throttled: false, camera_ok: true, verifier_online: true });
}

// ---- session A: pico-1, fails, fixes, passes, hands over ----
const A = S.a;
session(2, A, "joining", 0.1);
say(2.5, A, "user", "Ticket pico/led-sequence-trap: LEDs 0 and 2 for 500 ms, then only LED 1 for 500 ms, three times.");
session(5, A, "running", 0.2);
lease(6, "rig-1", "pico-1", "L-a1", A, "granted", { token: 17, expires_at: T0 + 6 + 300 });
device(6, "rig-1", "pico-1", "leased", holder(A), 0);
say(7, A, "devin", "Leased rig-1/pico-1 (token 17). Flashing my first build.");
run(10, "rig-1", "pico-1", "r-a1", "fetching");
log(10.3, "rig-1", "pico-1", "r-a1", ["git fetch origin fix/led-steps", "HEAD is now at 3f9c2e1 add LED step table"]);
run(13, "rig-1", "pico-1", "r-a1", "building");
log(13.2, "rig-1", "pico-1", "r-a1", ["cmake --build build -j4", "[ 42%] Building C object main.c.obj", "[100%] Linking led_seq.elf", "picotool load led_seq.uf2 -f"], 1.1);
run(18, "rig-1", "pico-1", "r-a1", "running");
log(18.4, "rig-1", "pico-1", "r-a1", ["boot: led_seq v0.1", "step 1: on=[0,2]", "step 2: on=[1]", "step 1: on=[0,2]", "step 2: on=[1]"], 0.8);
session(15, A, "running", 0.5);
verify(22, "rig-1", "pico-1", "v-a1", "pending");
verify(26, "rig-1", "pico-1", "v-a1", "done", [ledFail]);
evidence(26.6, "rig-1", "pico-1", "ev-a1-7c41e0", false);
session(25, A, "running", 0.8);
say(28, A, "devin", "The camera saw LED 0 still on during step 2. I set LED 1 high but never cleared LED 0. Fixing the step transition.");
say(31, A, "user", "Good catch. Write the whole bank on every step instead of toggling single pins.");
say(34, A, "devin", "Done: each step now writes the full LED mask. Re-flashing and asking the camera again.");
session(35, A, "running", 1.1);
lease(36, "rig-1", "pico-1", "L-a1", A, "renewed", { expires_at: T0 + 36 + 300 });
run(38, "rig-1", "pico-1", "r-a2", "fetching");
log(38.3, "rig-1", "pico-1", "r-a2", ["git fetch origin fix/led-steps", "HEAD is now at a07d5b8 write full LED mask per step"]);
run(41, "rig-1", "pico-1", "r-a2", "building");
log(41.2, "rig-1", "pico-1", "r-a2", ["cmake --build build -j4", "[100%] Linking led_seq.elf", "picotool load led_seq.uf2 -f"], 1.3);
run(46, "rig-1", "pico-1", "r-a2", "running");
log(46.4, "rig-1", "pico-1", "r-a2", ["boot: led_seq v0.2", "step 1: mask=0b0101", "step 2: mask=0b0010", "step 1: mask=0b0101", "step 2: mask=0b0010"], 0.8);
session(45, A, "running", 1.4);
verify(50, "rig-1", "pico-1", "v-a2", "pending");
verify(54, "rig-1", "pico-1", "v-a2", "done", [ledPass(502, 497)]);
evidence(54.6, "rig-1", "pico-1", "ev-a2-d93b58", true);
session(55, A, "running", 1.6);
say(56, A, "devin", "Camera confirmed all 3 repeats (502 ms and 497 ms, ±33 ms). Opening the PR and releasing pico-1 for the next session.");
run(59, "rig-1", "pico-1", "r-a2", "stopped");
lease(60, "rig-1", "pico-1", "L-a1", A, "released");
device(60, "rig-1", "pico-1", "resetting", undefined, 1);
session(62, A, "finished", 1.7);

// ---- session B: unoq-1 matrix heart, then a self-reported check on rig-2/pico-2 ----
const B = S.b;
session(8, B, "joining", 0.1);
say(8.5, B, "user", "Ticket unoq/matrix-heart: show a heart on the Uno Q matrix and hold it.");
session(11, B, "running", 0.2);
lease(12, "rig-1", "unoq-1", "L-b1", B, "granted", { token: 4, expires_at: T0 + 12 + 300 });
device(12, "rig-1", "unoq-1", "leased", holder(B), 0);
run(16, "rig-1", "unoq-1", "r-b1", "fetching");
log(16.3, "rig-1", "unoq-1", "r-b1", ["git fetch origin matrix-heart", "HEAD is now at 61be0aa heart frame"]);
run(19, "rig-1", "unoq-1", "r-b1", "building");
log(19.3, "rig-1", "unoq-1", "r-b1", ["arduino-cli compile --fqbn arduino:zephyr:unoq", "Sketch uses 48212 bytes (4%)", "arduino-cli upload -p /dev/ttyACM1"], 1.4);
run(25, "rig-1", "unoq-1", "r-b1", "running");
log(25.4, "rig-1", "unoq-1", "r-b1", ["matrix: frame heart", "READY"]);
session(21, B, "running", 0.5);
verify(30, "rig-1", "unoq-1", "v-b1", "pending");
verify(34, "rig-1", "unoq-1", "v-b1", "done", [matrixPass]);
evidence(34.6, "rig-1", "unoq-1", "ev-b1-4af210", true);
say(35.5, B, "devin", "Heart frame confirmed by the camera: 1 cell off (tolerance 2), held 2.4 s.");
session(36, B, "running", 0.8);
lease(38, "rig-2", "pico-2", "L-b2", B, "granted", { token: 1, expires_at: T0 + 38 + 300 });
device(38, "rig-2", "pico-2", "leased", holder(B), 0);
run(39, "rig-2", "pico-2", "r-b2", "fetching");
run(41, "rig-2", "pico-2", "r-b2", "building");
log(41.3, "rig-2", "pico-2", "r-b2", ["cmake --build build -j4", "picotool load ready.uf2 -f"], 1.2);
run(43.5, "rig-2", "pico-2", "r-b2", "running");
log(43.8, "rig-2", "pico-2", "r-b2", ["boot: ready-probe v1", "uart ok", "READY"], 0.6);
verify(46, "rig-2", "pico-2", "v-b2", "pending");
verify(47.5, "rig-2", "pico-2", "v-b2", "done", [readySelf]);
say(48.5, B, "devin", "The READY check on rig-2/pico-2 only matched the serial log, so it is marked self-reported, not camera-confirmed.");
session(48, B, "running", 1.0);
lease(52, "rig-2", "pico-2", "L-b2", B, "released");
device(52, "rig-2", "pico-2", "resetting", undefined, 0);
device(57, "rig-2", "pico-2", "free", undefined, 0);
lease(42, "rig-1", "unoq-1", "L-b1", B, "renewed", { expires_at: T0 + 42 + 300 });
session(60, B, "running", 1.2);
session(75, B, "running", 1.3);
say(92, B, "devin", "PR is up with the evidence link. Releasing unoq-1.");
run(94, "rig-1", "unoq-1", "r-b1", "stopped");
lease(95, "rig-1", "unoq-1", "L-b1", B, "released");
device(95, "rig-1", "unoq-1", "resetting", undefined, 0);
session(96, B, "finished", 1.4);
device(101, "rig-1", "unoq-1", "free", undefined, 0);

// ---- session C: queued #1 on pico-1, granted after the hand-over (token 18) ----
const C = S.c;
session(14, C, "joining", 0.1);
say(14.5, C, "user", "Ticket pico/led-sequence: same LED sequence, clean implementation.");
session(17, C, "running", 0.2);
lease(18, "rig-1", "pico-1", "L-c1", C, "queued", { position: 1 });
device(18, "rig-1", "pico-1", "leased", holder(A), 1);
say(19, C, "devin", "pico-1 is busy. I'm #1 in the queue and will start when it is handed over.");
session(40, C, "running", 0.3);
// hand-over: resetting at 60, idle confirmed (free) at 66, granted at 67
device(66, "rig-1", "pico-1", "free", undefined, 1);
lease(67, "rig-1", "pico-1", "L-c1", C, "granted", { token: 18, expires_at: T0 + 67 + 300 });
device(67, "rig-1", "pico-1", "leased", holder(C), 0);
say(68, C, "devin", "Got pico-1 with token 18 after the idle check. Flashing now.");
run(70, "rig-1", "pico-1", "r-c1", "fetching");
log(70.3, "rig-1", "pico-1", "r-c1", ["git fetch origin led-sequence", "HEAD is now at 0bd44c2 LED sequence via mask table"]);
run(73, "rig-1", "pico-1", "r-c1", "building");
log(73.2, "rig-1", "pico-1", "r-c1", ["cmake --build build -j4", "[100%] Linking led_seq.elf", "picotool load led_seq.uf2 -f"], 1.3);
run(78, "rig-1", "pico-1", "r-c1", "running");
log(78.4, "rig-1", "pico-1", "r-c1", ["boot: led_seq", "READY", "step 1: mask=0b0101", "step 2: mask=0b0010"], 0.8);
session(80, C, "running", 0.6);
verify(84, "rig-1", "pico-1", "v-c1", "pending");
verify(88, "rig-1", "pico-1", "v-c1", "done", [ledPass(499, 501), { ...readySelf, measured: { line: "READY", line_no: 2 }, detail: "matched in run log line 2 (not checked by camera)" }]);
evidence(88.6, "rig-1", "pico-1", "ev-c1-12e8f7", true);
say(90, C, "devin", "Camera confirmed the sequence (499 ms and 501 ms, ±33 ms). Writing up the PR.");
session(92, C, "running", 0.8);
lease(97, "rig-1", "pico-1", "L-c1", C, "renewed", { expires_at: T0 + 97 + 300 });
session(105, C, "running", 0.9);
say(108, C, "user", "Looks good. Leave the board flashed, I want to watch it run.");

// ---- serialise ----
out.sort((x, y) => x.t - y.t || x.seq - y.seq);
const lines = [JSON.stringify({ name: "graph_snapshot", data: { ...snapshot, ts: T0 } })];
for (const { ev } of out) lines.push(JSON.stringify(ev, (_k, v) => (v === undefined ? undefined : v)));
const text = lines.join("\n") + "\n";

if (process.argv.includes("--stdout")) {
  process.stdout.write(text);
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../public/fixtures/demo.ndjson");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${lines.length} events (${END} s) to ${file}`);
}
