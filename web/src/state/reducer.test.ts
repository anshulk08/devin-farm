import { describe, expect, it } from "vitest";
import { applyEvent, foldEvents, initialState, MAX_LOGS, MAX_TOASTS, reducer, verdictTone, type FarmState } from "./reducer";
import type { AssertionResult, FarmEvent } from "./types";
import { sampleGraph, T0 } from "../data/sampleGraph";

const snap: FarmEvent = { name: "graph_snapshot", data: { ...sampleGraph, ts: T0 } };
const base = (): FarmState => foldEvents([snap]);
const run = (s: FarmState, ...evs: FarmEvent[]) => evs.reduce(applyEvent, s);

type LeaseData = Extract<FarmEvent, { name: "lease" }>["data"];
const lease = (d: Partial<LeaseData> & Pick<LeaseData, "lease_id" | "holder" | "event">, ts = T0 + 1): FarmEvent => ({
  name: "lease",
  data: { rig_id: "rig-1", device: "pico-1", ts, ...d },
});
const verify = (state: "pending" | "done" | "error", results?: AssertionResult[], verify_id = "v-1", ts = T0 + 5): FarmEvent => ({
  name: "verify",
  data: { rig_id: "rig-1", device: "pico-1", verify_id, state, results, ts },
});

const measured = (passed: boolean, type = "led_sequence"): AssertionResult => ({
  type,
  target: "pico.leds",
  passed,
  measured: { steps: [] },
  expected: { steps: [] },
  uncertainty: { ms: 33 },
  detail: passed ? undefined : "step 2: LED 0 still on (expected only LED 1)",
  self_reported: false,
});
const selfReported = (passed: boolean): AssertionResult => ({ type: "log_contains", passed, self_reported: true });

const PICO1 = "device:rig-1/pico-1";
const queueEdges = (s: FarmState, dev = PICO1) =>
  Object.values(s.edges)
    .filter((e) => e.kind === "queue" && e.target === dev)
    .sort((a, b) => (a.data?.position ?? 0) - (b.data?.position ?? 0));

describe("graph_snapshot", () => {
  it("loads nodes and edges by id and advances now", () => {
    const s = base();
    expect(Object.keys(s.nodes)).toHaveLength(sampleGraph.nodes.length);
    expect(Object.keys(s.edges)).toHaveLength(sampleGraph.edges.length);
    expect(s.nodes[PICO1].status).toBe("leased");
    expect(s.edges["lease:L-a1"].data?.token).toBe(17);
    expect(s.now).toBe(T0);
    expect(s.connection).toBe("open");
  });

  it("replaces the previous graph entirely", () => {
    const s = run(base(), { name: "graph_snapshot", data: { nodes: [sampleGraph.nodes[3]], edges: [], ts: T0 + 10 } });
    expect(Object.keys(s.nodes)).toEqual(["rig:rig-1"]);
    expect(s.edges).toEqual({});
  });

  it("never moves now backwards", () => {
    const s = run(base(), { name: "session_message", data: { farm_id: "s-1a2b3c4d", source: "user", text: "hi", ts: T0 - 50 } });
    expect(s.now).toBe(T0);
  });
});

describe("lease", () => {
  // Two extra sessions queued behind s-9c0d1e2f (#1) on pico-1.
  const withQueue = () =>
    run(
      base(),
      lease({ lease_id: "L-d1", holder: "devin-s-dddd", event: "queued", position: 2 }),
      lease({ lease_id: "L-e1", holder: "devin-s-eeee", event: "queued", position: 3 }),
    );

  it("queued adds a numbered queue edge from the holder's session", () => {
    const q = queueEdges(withQueue());
    expect(q.map((e) => [e.id, e.source, e.data?.position])).toEqual([
      ["queue:L-c1", "session:s-9c0d1e2f", 1],
      ["queue:L-d1", "session:s-dddd", 2],
      ["queue:L-e1", "session:s-eeee", 3],
    ]);
  });

  it("granted removes the queue edge, adds a lease edge with token/expiry, and renumbers the rest", () => {
    let s = withQueue();
    s = run(s, lease({ lease_id: "L-a1", holder: "devin-s-1a2b3c4d", event: "released" }, T0 + 2));
    s = run(s, lease({ lease_id: "L-c1", holder: "devin-s-9c0d1e2f", event: "granted", token: 18, expires_at: T0 + 400 }, T0 + 3));
    expect(s.edges["queue:L-c1"]).toBeUndefined();
    expect(s.edges["lease:L-c1"]).toMatchObject({ kind: "lease", source: "session:s-9c0d1e2f", target: PICO1, data: { token: 18, expires_at: T0 + 400 } });
    expect(queueEdges(s).map((e) => [e.id, e.data?.position])).toEqual([
      ["queue:L-d1", 1],
      ["queue:L-e1", 2],
    ]);
  });

  it("renewed extends expires_at and keeps the token", () => {
    const s = run(base(), lease({ lease_id: "L-a1", holder: "devin-s-1a2b3c4d", event: "renewed", expires_at: T0 + 900 }));
    expect(s.edges["lease:L-a1"].data).toEqual({ token: 17, expires_at: T0 + 900 });
  });

  it("released removes the lease edge without a toast", () => {
    const s = run(base(), lease({ lease_id: "L-a1", holder: "devin-s-1a2b3c4d", event: "released" }));
    expect(s.edges["lease:L-a1"]).toBeUndefined();
    expect(s.toasts).toHaveLength(0);
  });

  it.each(["expired", "revoked"] as const)("%s removes the lease edge and raises a toast on the device", (event) => {
    const s = run(base(), lease({ lease_id: "L-a1", holder: "devin-s-1a2b3c4d", event }));
    expect(s.edges["lease:L-a1"]).toBeUndefined();
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ nodeId: PICO1, tone: "info" });
    expect(s.toasts[0].text).toContain(event);
  });

  it("a queued session that leaves drops its queue edge and the others move up", () => {
    let s = withQueue();
    s = run(s, lease({ lease_id: "L-c1", holder: "devin-s-9c0d1e2f", event: "revoked" }));
    expect(queueEdges(s).map((e) => [e.id, e.data?.position])).toEqual([
      ["queue:L-d1", 1],
      ["queue:L-e1", 2],
    ]);
  });
});

describe("verify", () => {
  it("pending marks the device as verifying", () => {
    const s = run(base(), verify("pending"));
    expect(s.devices[PICO1].verifying).toEqual({ verify_id: "v-1", since: T0 + 5 });
  });

  it("done clears verifying, sets lastVerdict and toasts", () => {
    const s = run(base(), verify("pending"), verify("done", [measured(false)], "v-1", T0 + 9));
    const d = s.devices[PICO1];
    expect(d.verifying).toBeUndefined();
    expect(d.lastVerdict).toMatchObject({ verify_id: "v-1", tone: "fail", at: T0 + 9 });
    expect(s.toasts.at(-1)).toMatchObject({ id: "verify-v-1", nodeId: PICO1, tone: "fail" });
    expect(s.toasts.at(-1)!.text).toBe("pico-1: led_sequence ✗ step 2: LED 0 still on (expected only LED 1)");
  });

  it("measured pass → pass, confirmed by camera", () => {
    const s = run(base(), verify("done", [measured(true), selfReported(true)]));
    expect(s.devices[PICO1].lastVerdict!.tone).toBe("pass");
    expect(s.toasts.at(-1)!.text).toContain("confirmed by camera");
  });

  it("self-reported only is never green", () => {
    const s = run(base(), verify("done", [selfReported(true)]));
    expect(s.devices[PICO1].lastVerdict!.tone).toBe("self");
    expect(s.toasts.at(-1)!.text).toContain("self-reported only");
  });

  it("error is a fail", () => {
    const s = run(base(), verify("error"));
    expect(s.devices[PICO1].lastVerdict!.tone).toBe("fail");
  });

  it("verdictTone: any measured fail wins", () => {
    expect(verdictTone([measured(true), measured(false, "matrix_frame"), selfReported(true)])).toBe("fail");
    expect(verdictTone([measured(true)])).toBe("pass");
    expect(verdictTone([selfReported(true)])).toBe("self");
    expect(verdictTone([selfReported(false)])).toBe("self");
    expect(verdictTone([measured(true), selfReported(false)])).toBe("fail");
    expect(verdictTone([])).toBe("self");
  });

  it("toasts are capped", () => {
    let s = base();
    for (let i = 0; i < MAX_TOASTS + 3; i++) s = run(s, verify("done", [measured(true)], `v-${i}`));
    expect(s.toasts).toHaveLength(MAX_TOASTS);
    expect(s.toasts.at(-1)!.id).toBe(`verify-v-${MAX_TOASTS + 2}`);
  });
});

describe("evidence", () => {
  it("attaches the evidence id to the last verdict", () => {
    const s = run(base(), verify("done", [measured(true)]), {
      name: "evidence",
      data: { rig_id: "rig-1", device: "pico-1", evidence_id: "ev-123", passed: true, ts: T0 + 6 },
    });
    expect(s.devices[PICO1].lastVerdict!.evidence_id).toBe("ev-123");
  });

  it("is ignored when there is no verdict yet", () => {
    const s0 = base();
    const s = run(s0, { name: "evidence", data: { rig_id: "rig-1", device: "pico-1", evidence_id: "ev-x", passed: true, ts: T0 + 6 } });
    expect(s.devices).toEqual(s0.devices);
  });
});

describe("session", () => {
  const sess = (status: string, acus: number, ts: number): FarmEvent => ({
    name: "session",
    data: { farm_id: "s-new00001", devin_session_id: "d-1", status, acus, title: "pico/blink", url: "https://example/s", ts },
  });

  it("creates a node on first sight with created_at = ts", () => {
    const s = run(base(), sess("joining", 0.1, T0 + 100));
    expect(s.nodes["session:s-new00001"]).toMatchObject({ kind: "session", status: "joining", label: "pico/blink", data: { acus: 0.1, created_at: T0 + 100 } });
  });

  it("upserts status/acus and keeps created_at", () => {
    const s = run(base(), sess("joining", 0.1, T0 + 100), sess("running", 0.7, T0 + 160));
    const n = s.nodes["session:s-new00001"];
    expect(n.status).toBe("running");
    expect(n.data.acus).toBe(0.7);
    expect(n.data.created_at).toBe(T0 + 100);
  });

  it("keeps created_at from the snapshot for known sessions", () => {
    const s = run(base(), { name: "session", data: { farm_id: "s-5e6f7a8b", devin_session_id: "d", status: "blocked", acus: 2, title: "unoq/matrix-heart", url: "u", ts: T0 + 500 } });
    expect(s.nodes["session:s-5e6f7a8b"].data.created_at).toBe(T0 + 20);
  });
});

describe("logs and runs", () => {
  const logEv = (i: number, run_id = "r-1"): FarmEvent => ({ name: "log", data: { rig_id: "rig-1", device: "pico-1", run_id, text: `line ${i}`, ts: T0 + i } });

  it(`caps device logs at MAX_LOGS (${MAX_LOGS}), keeping the newest`, () => {
    let s = base();
    for (let i = 0; i < MAX_LOGS + 25; i++) s = applyEvent(s, logEv(i));
    const logs = s.devices[PICO1].logs;
    expect(logs).toHaveLength(MAX_LOGS);
    expect(logs[0].text).toBe("line 25");
    expect(logs.at(-1)!.text).toBe(`line ${MAX_LOGS + 24}`);
  });

  it("a new run_id clears the log tail; the same run keeps it", () => {
    const r = (run_id: string, state: "fetching" | "building"): FarmEvent => ({ name: "run", data: { rig_id: "rig-1", device: "pico-1", run_id, state, ts: T0 + 1 } });
    let s = run(base(), r("r-1", "fetching"), logEv(1), r("r-1", "building"));
    expect(s.devices[PICO1].logs).toHaveLength(1);
    expect(s.devices[PICO1].run).toMatchObject({ run_id: "r-1", state: "building" });
    s = run(s, r("r-2", "fetching"));
    expect(s.devices[PICO1].logs).toHaveLength(0);
  });
});

describe("other events", () => {
  it("device patches status, holder and queue depth", () => {
    const s = run(base(), { name: "device", data: { rig_id: "rig-1", device: "pico-1", status: "resetting", queue_depth: 1, ts: T0 + 2 } });
    expect(s.nodes[PICO1]).toMatchObject({ status: "resetting", data: { holder: null, queue_depth: 1, type: "pico" } });
  });

  it("rig_health patches the rig, the camera and history", () => {
    const s = run(base(), {
      name: "rig_health",
      data: { rig_id: "rig-1", temp_c: 61.2, load1: 3.1, mem_free_mb: 900, throttled: true, camera_ok: false, verifier_online: true, ts: T0 + 5 },
    });
    expect(s.nodes["rig:rig-1"].data).toMatchObject({ temp_c: 61.2, throttled: true, last_seen: T0 + 5 });
    expect(s.nodes["camera:rig-1"].status).toBe("down");
    expect(s.rigHistory["rig:rig-1"]).toEqual([{ ts: T0 + 5, temp_c: 61.2, load1: 3.1 }]);
  });

  it("events for unknown nodes do not create them", () => {
    const s = run(base(), { name: "device", data: { rig_id: "rig-9", device: "ghost", status: "free", queue_depth: 0, ts: T0 + 2 } });
    expect(s.nodes["device:rig-9/ghost"]).toBeUndefined();
  });

  it("reset keeps the connection status and clears everything else", () => {
    const s = reducer({ ...base(), connection: "lost" }, { type: "reset" });
    expect(s).toEqual({ ...initialState, connection: "lost" });
  });
});
