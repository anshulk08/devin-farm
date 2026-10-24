// Lints web/public/fixtures/demo.ndjson and checks the story it tells ends where the demo expects.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEvent, foldEvents, initialState, type FarmState } from "./reducer";
import { ids, type FarmEvent } from "./types";
import { sampleGraph } from "../data/sampleGraph";

const FILE = resolve(__dirname, "../../public/fixtures/demo.ndjson");
const text = readFileSync(FILE, "utf8");
const lines = text.split("\n").filter((l) => l.trim() !== "");
const events: FarmEvent[] = lines.map((l) => JSON.parse(l));
const NAMES = new Set(["graph_snapshot", "rig_health", "device", "lease", "run", "log", "verify", "evidence", "session", "session_message"]);

describe("demo fixture lint", () => {
  it("every line is a JSON FarmEvent with a numeric ts", () => {
    lines.forEach((l, i) => {
      const ev = JSON.parse(l);
      expect(NAMES.has(ev.name), `line ${i + 1}: unknown name ${ev.name}`).toBe(true);
      expect(typeof ev.data?.ts, `line ${i + 1}: ts`).toBe("number");
    });
  });

  it("starts with a graph_snapshot and has exactly one", () => {
    expect(events[0].name).toBe("graph_snapshot");
    expect(events.filter((e) => e.name === "graph_snapshot")).toHaveLength(1);
  });

  it("timestamps never go backwards and span 90–120 s", () => {
    for (let i = 1; i < events.length; i++) expect(events[i].data.ts, `line ${i + 1}`).toBeGreaterThanOrEqual(events[i - 1].data.ts);
    const span = events.at(-1)!.data.ts - events[0].data.ts;
    expect(span).toBeGreaterThanOrEqual(90);
    expect(span).toBeLessThanOrEqual(120);
  });

  it("uses the sampleGraph topology and IDs", () => {
    const snap = events[0] as Extract<FarmEvent, { name: "graph_snapshot" }>;
    const hw = (n: { kind: string }) => n.kind !== "session";
    expect(snap.data.nodes.filter(hw).map((n) => n.id).sort()).toEqual(sampleGraph.nodes.filter(hw).map((n) => n.id).sort());
    const sessions = new Set(events.filter((e) => e.name === "session").map((e) => ids.session((e.data as { farm_id: string }).farm_id)));
    expect([...sessions].sort()).toEqual(sampleGraph.nodes.filter((n) => n.kind === "session").map((n) => n.id).sort());
  });

  it("every referenced device/rig/session exists in the snapshot or a prior session event", () => {
    const known = new Set((events[0] as Extract<FarmEvent, { name: "graph_snapshot" }>).data.nodes.map((n) => n.id));
    events.forEach((ev, i) => {
      const at = `line ${i + 1} (${ev.name})`;
      const d = ev.data as unknown as Record<string, unknown>;
      if (ev.name === "session") {
        known.add(ids.session(ev.data.farm_id));
        return;
      }
      if (typeof d.rig_id === "string") expect(known.has(ids.rig(d.rig_id)), `${at}: rig ${d.rig_id}`).toBe(true);
      if (typeof d.device === "string") expect(known.has(ids.device(d.rig_id as string, d.device)), `${at}: device ${d.device}`).toBe(true);
      if (typeof d.holder === "string") expect(known.has(ids.sessionFromHolder(d.holder)), `${at}: holder ${d.holder}`).toBe(true);
      if (ev.name === "session_message") expect(known.has(ids.session(ev.data.farm_id)), `${at}: session ${ev.data.farm_id}`).toBe(true);
    });
  });

  it("lease grants carry token and expiry; tokens increase per device", () => {
    const last: Record<string, number> = {};
    for (const ev of events) {
      if (ev.name !== "lease" || ev.data.event !== "granted") continue;
      expect(ev.data.token).toBeTypeOf("number");
      expect(ev.data.expires_at!).toBeGreaterThan(ev.data.ts);
      const k = `${ev.data.rig_id}/${ev.data.device}`;
      if (k in last) expect(ev.data.token!).toBeGreaterThan(last[k]);
      last[k] = ev.data.token!;
    }
  });

  it("verify results follow C6: measured value on every camera check", () => {
    for (const ev of events) {
      if (ev.name !== "verify" || ev.data.state !== "done") continue;
      for (const r of ev.data.results ?? []) {
        if (r.type === "log_contains") expect(r.self_reported).toBe(true);
        else {
          expect(r.self_reported).toBe(false);
          expect(r.measured).toBeDefined();
          expect(r.expected).toBeDefined();
          expect(r.uncertainty).toBeDefined();
        }
      }
    }
  });
});

describe("demo fixture story", () => {
  const final = foldEvents(events);

  it("ends with pico-1 held by s-9c0d1e2f on token 18 and nobody queued", () => {
    const pico1 = ids.device("rig-1", "pico-1");
    const leases = Object.values(final.edges).filter((e) => e.kind === "lease" && e.target === pico1);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ source: "session:s-9c0d1e2f", data: { token: 18 } });
    expect(Object.values(final.edges).filter((e) => e.kind === "queue")).toHaveLength(0);
    expect(final.nodes[pico1]).toMatchObject({ status: "leased", data: { holder: "devin-s-9c0d1e2f", queue_depth: 0 } });
    expect(final.devices[pico1].lastVerdict).toMatchObject({ tone: "pass", evidence_id: expect.any(String) });
  });

  it("ends with the other sessions finished and their boards free", () => {
    expect(final.nodes["session:s-1a2b3c4d"].status).toBe("finished");
    expect(final.nodes["session:s-5e6f7a8b"].status).toBe("finished");
    expect(final.nodes["session:s-9c0d1e2f"].status).toBe("running");
    expect(final.nodes["device:rig-1/unoq-1"].status).toBe("free");
    expect(final.nodes["device:rig-2/pico-2"].status).toBe("free");
    expect(final.nodes["device:rig-2/unoq-2"].status).toBe("offline");
  });

  it("tells the beats in order: queued #1, fail, pass, self-reported, hand-over", () => {
    const tones: string[] = [];
    let s: FarmState = { ...initialState, connection: "open" };
    let sawQueue = false;
    let sawResetting = false;
    let sawIdleWithQueue = false;
    for (const ev of events) {
      s = applyEvent(s, ev);
      if (ev.name === "lease" && ev.data.event === "queued") {
        sawQueue = true;
        expect(s.edges["queue:L-c1"].data?.position).toBe(1);
      }
      if (ev.name === "verify" && ev.data.state === "done") tones.push(`${ev.data.device}:${s.devices[ids.device(ev.data.rig_id, ev.data.device)].lastVerdict!.tone}`);
      const p = s.nodes["device:rig-1/pico-1"];
      if (p.status === "resetting") sawResetting = true;
      if (sawResetting && p.status === "free" && s.edges["queue:L-c1"]) sawIdleWithQueue = true;
    }
    expect(sawQueue).toBe(true);
    expect(tones).toEqual(["pico-1:fail", "unoq-1:pass", "pico-2:self", "pico-1:pass", "pico-1:pass"]);
    expect(sawIdleWithQueue).toBe(true);
  });

  it("the failing verdict carries the step-2 detail", () => {
    const fail = events.find((e) => e.name === "verify" && e.data.state === "done" && e.data.results?.some((r) => !r.passed));
    expect(fail && fail.name === "verify" && fail.data.results![0].detail).toBe("step 2: LED 0 still on (expected only LED 1)");
  });

  it("ACU counters only grow", () => {
    const last: Record<string, number> = {};
    for (const ev of events) {
      if (ev.name !== "session") continue;
      expect(ev.data.acus).toBeGreaterThanOrEqual(last[ev.data.farm_id] ?? 0);
      last[ev.data.farm_id] = ev.data.acus;
    }
  });

  it("rig_health arrives every 5 s for both rigs", () => {
    for (const rig of ["rig-1", "rig-2"]) {
      const ts = events.filter((e) => e.name === "rig_health" && e.data.rig_id === rig).map((e) => e.data.ts);
      expect(ts.length).toBeGreaterThan(18);
      for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeCloseTo(5, 5);
    }
  });
});
