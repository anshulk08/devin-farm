import { renderToStaticMarkup } from "react-dom/server";
import { applyEvent, initialState, type FarmState } from "../state/reducer";
import { sampleGraph, T0 } from "../data/sampleGraph";
import type { FarmEvent } from "../state/types";
import { computeLayout, layoutInputFrom, layoutKey } from "./layout";
import { buildEdges, buildNodes, shortFarmId, stabilize, type DeviceData, type LeaseEdgeData, type MapEdge, type MapNode } from "./build";
import { verticalCurve } from "./edges/edges";
import { Tooltip } from "./Tooltip";
import { SESSION_H } from "./geometry";

const snap = (): FarmState => applyEvent({ ...initialState, connection: "open" }, { name: "graph_snapshot", data: { ...sampleGraph, ts: T0 } });
const fold = (s: FarmState, evs: FarmEvent[]) => evs.reduce(applyEvent, s);

describe("layout", () => {
  it("puts sessions in a top band by creation order and rigs below, devices in bench order", () => {
    const s = snap();
    const input = layoutInputFrom(s.nodes);
    expect(input.sessions).toEqual(["session:s-1a2b3c4d", "session:s-5e6f7a8b", "session:s-9c0d1e2f"]);
    expect(input.rigs.map((r) => r.id)).toEqual(["rig:rig-1", "rig:rig-2"]);
    expect(input.rigs[0].devices).toEqual(["device:rig-1/pico-1", "device:rig-1/unoq-1", "device:rig-1/pico-3"]);
    expect(input.rigs[0].camera).toBe("camera:rig-1");

    const l = computeLayout(input);
    const xs = input.sessions.map((id) => l.pos[id].x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs); // left-to-right = creation order
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(200); // no overlap
    for (const id of input.sessions) expect(l.pos[id].y + SESSION_H).toBeLessThan(l.pos["rig:rig-1"].y);
    expect(l.pos["rig:rig-1"].x + l.rigSize["rig:rig-1"].w).toBeLessThan(l.pos["rig:rig-2"].x);
    const dx = input.rigs[0].devices.map((d) => l.pos[d].x);
    expect([...dx].sort((a, b) => a - b)).toEqual(dx);
  });

  it("is deterministic and keyed only on the node set, so status events never reshuffle it", () => {
    const s0 = snap();
    const s1 = fold(s0, [
      { name: "device", data: { ts: T0 + 1, rig_id: "rig-1", device: "pico-1", status: "resetting", queue_depth: 0 } },
      { name: "rig_health", data: { ts: T0 + 2, rig_id: "rig-1", temp_c: 50, load1: 1, mem_free_mb: 1, throttled: false, camera_ok: true, verifier_online: true } },
    ]);
    expect(layoutKey(layoutInputFrom(s1.nodes))).toBe(layoutKey(layoutInputFrom(s0.nodes)));
    expect(computeLayout(layoutInputFrom(s0.nodes))).toEqual(computeLayout(layoutInputFrom(s0.nodes)));

    const s2 = fold(s0, [
      { name: "session", data: { ts: T0 + 90, farm_id: "s-new", devin_session_id: "x", status: "joining", acus: 0, title: "unoq/x", url: "" } },
    ]);
    const k2 = layoutInputFrom(s2.nodes);
    expect(layoutKey(k2)).not.toBe(layoutKey(layoutInputFrom(s0.nodes)));
    expect(k2.sessions.at(-1)).toBe("session:s-new");
  });
});

describe("build", () => {
  const opts = { liveThumbs: false, selectedId: null };

  it("colours a leased device with its holder's hue and marks the lease active only during work", () => {
    let s = snap();
    const l = computeLayout(layoutInputFrom(s.nodes));
    let nodes = buildNodes(s, l, opts);
    const ids = new Set(nodes.map((n) => n.id));
    const pico1 = nodes.find((n) => n.id === "device:rig-1/pico-1")!.data as DeviceData;
    expect(pico1.hue).toMatch(/^var\(--s\d\)$/);
    expect(pico1.holderShort).toBe("1a2b");
    const free = nodes.find((n) => n.id === "device:rig-1/pico-3")!.data as DeviceData;
    expect(free.hue).toBeNull();

    const lease = () => buildEdges(s, ids, new Set()).find((e) => e.id === "lease:L-a1")!.data as LeaseEdgeData;
    expect(lease().active).toBe(false);
    expect(lease().token).toBe(17);
    s = fold(s, [{ name: "run", data: { ts: T0 + 3, rig_id: "rig-1", device: "pico-1", run_id: "r", state: "building" } }]);
    expect(lease().active).toBe(true);
    s = fold(s, [{ name: "run", data: { ts: T0 + 4, rig_id: "rig-1", device: "pico-1", run_id: "r", state: "stopped" } }]);
    expect(lease().active).toBe(false);
    s = fold(s, [{ name: "verify", data: { ts: T0 + 5, rig_id: "rig-1", device: "pico-1", verify_id: "v", state: "pending" } }]);
    expect(lease().active).toBe(true);
    nodes = buildNodes(s, l, opts);
    const cam = nodes.find((n) => n.id === "camera:rig-1")!.data as { scans: { id: string }[] };
    expect(cam.scans.map((x) => x.id)).toEqual(["device:rig-1/pico-1"]);
  });

  it("gives every node fixed measured dimensions so React Flow keeps handle bounds across updates", () => {
    const s = snap();
    const nodes = buildNodes(s, computeLayout(layoutInputFrom(s.nodes)), opts);
    for (const n of nodes) expect(n.measured).toEqual({ width: n.width, height: n.height });
  });

  it("keeps object identity for unchanged nodes and edges", () => {
    const s0 = snap();
    const l = computeLayout(layoutInputFrom(s0.nodes));
    const a = buildNodes(s0, l, { liveThumbs: false, selectedId: null });
    const prev = new Map<string, MapNode>(a.map((n) => [n.id, n]));
    const s1 = fold(s0, [{ name: "device", data: { ts: T0 + 1, rig_id: "rig-1", device: "pico-3", status: "resetting", queue_depth: 0 } }]);
    const b = stabilize(prev, buildNodes(s1, l, { liveThumbs: false, selectedId: null }));
    for (const n of b) {
      if (n.id === "device:rig-1/pico-3") expect(n).not.toBe(prev.get(n.id));
      else expect(n).toBe(prev.get(n.id));
    }
    const ids = new Set(a.map((n) => n.id));
    const e0 = buildEdges(s0, ids, new Set());
    const e1 = stabilize(new Map<string, MapEdge>(e0.map((e) => [e.id, e])), buildEdges(s0, ids, new Set()));
    e1.forEach((e, i) => expect(e).toBe(e0[i]));
  });

  it("hands over: lease edge goes, queue edge becomes the new lease", () => {
    const s = fold(snap(), [
      { name: "lease", data: { ts: T0 + 10, rig_id: "rig-1", device: "pico-1", lease_id: "L-a1", holder: "devin-s-1a2b3c4d", event: "released" } },
      { name: "lease", data: { ts: T0 + 14, rig_id: "rig-1", device: "pico-1", lease_id: "L-c1", holder: "devin-s-9c0d1e2f", event: "granted", token: 18, expires_at: T0 + 314 } },
    ]);
    const ids = new Set(Object.keys(s.nodes));
    const e = buildEdges(s, ids, new Set());
    expect(e.find((x) => x.id === "lease:L-a1")).toBeUndefined();
    expect(e.find((x) => x.id === "queue:L-c1")).toBeUndefined();
    const lease = e.find((x) => x.id === "lease:L-c1")!;
    expect(lease.source).toBe("session:s-9c0d1e2f");
    expect(lease.type).toBe("lease");
    // Leases draw last (on top of queue/watches/attached).
    expect(e.at(-1)!.type).toBe("lease");
  });

  it("derives short labels", () => {
    expect(shortFarmId("session:s-1a2b3c4d")).toBe("1a2b");
    expect(shortFarmId("devin-s-9c0d1e2f")).toBe("9c0d");
  });
});

describe("edges + tooltip", () => {
  it("curve starts and ends at the handles", () => {
    const c = verticalCurve(10, 20, 200, 400);
    expect(c.at(0)).toEqual({ x: 10, y: 20 });
    expect(c.at(1)).toEqual({ x: 200, y: 400 });
    expect(c.d.startsWith("M10,20 C")).toBe(true);
  });

  it("tooltips state lease time left and queue position", () => {
    const s = snap();
    const html = renderToStaticMarkup(<Tooltip state={s} target={{ kind: "edge", id: "lease:L-a1", x: 0, y: 0 }} now={T0 + 108} bounds={{ w: 1000, h: 800 }} />);
    expect(html).toContain("Lease on pico-1");
    expect(html).toContain("3:12");
    const q = renderToStaticMarkup(<Tooltip state={s} target={{ kind: "node", id: "device:rig-1/pico-1", x: 0, y: 0 }} now={T0} bounds={{ w: 1000, h: 800 }} />);
    expect(q).toContain("#1 pico/led-sequence");
    expect(q).toContain("Fencing token");
  });
});
