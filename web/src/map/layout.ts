// Band layout (FRONTEND §2). Sessions in a top band inside the "Devin cloud", rigs side by side in a bottom band,
// devices in bench order inside their rig, camera centred under them.
// d3-force runs only within a band (collision + light centring, y locked to the band), synchronously, once.
// The result depends only on which nodes exist, so callers memoise it on `layoutKey` and positions stay pinned
// across every event that doesn't add or remove a node.
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { GNode } from "../state/types";
import {
  CAMERA_W,
  CLOUD_PAD_BOTTOM,
  CLOUD_PAD_TOP,
  CLOUD_PAD_X,
  BAND_GAP,
  RIG_CAMERA_Y,
  RIG_DEVICE_Y,
  RIG_GAP,
  RIG_H,
  SESSION_H,
  SESSION_SPACING,
  SESSION_W,
  deviceSlotX,
  rigWidth,
} from "./geometry";

export interface XY {
  x: number;
  y: number;
}

export interface LayoutInput {
  /** Session node ids, already ordered by created_at. */
  sessions: string[];
  /** Rigs in display order with their devices in bench order and optional camera. */
  rigs: { id: string; devices: string[]; camera?: string }[];
}

export interface Layout {
  /** Top-level nodes: absolute. Devices and cameras: relative to their rig (React Flow parentId). */
  pos: Record<string, XY>;
  rigSize: Record<string, { w: number; h: number }>;
  cloud: { x: number; y: number; w: number; h: number };
  /** Absolute centre of every node's circle, for geometry that crosses parents (camera scan arcs). */
  centre: Record<string, XY>;
}

export function layoutKey(input: LayoutInput): string {
  return [input.sessions.join(","), input.rigs.map((r) => `${r.id}[${r.devices.join(",")}|${r.camera ?? ""}]`).join(";")].join("#");
}

interface BandNode extends SimulationNodeDatum {
  id: string;
  r: number;
  tx: number;
}

/** Spread items along x around their targets without overlap; y stays locked. Deterministic. */
function settleBand(items: { id: string; r: number; tx: number; seed?: number }[]): Record<string, number> {
  if (items.length === 0) return {};
  const nodes: BandNode[] = items.map((it) => ({ id: it.id, r: it.r, tx: it.tx, x: it.seed ?? it.tx, y: 0, fy: 0 }));
  const sim = forceSimulation(nodes)
    .randomSource(() => 0.5)
    .force("x", forceX<BandNode>((d) => d.tx).strength(0.25))
    .force("centre", forceX<BandNode>(0).strength(0.01))
    .force("y", forceY<BandNode>(0).strength(1))
    .force("collide", forceCollide<BandNode>((d) => d.r).strength(0.9).iterations(3))
    .stop();
  for (let i = 0; i < 240; i++) sim.tick();
  // Keep the band's order exactly as given (creation order / bench order) even if collision swapped neighbours.
  const xs = nodes.map((n) => n.x ?? 0).sort((a, b) => a - b);
  const out: Record<string, number> = {};
  nodes.forEach((n, i) => (out[n.id] = xs[i]));
  return out;
}

export function computeLayout(input: LayoutInput, prev?: Layout): Layout {
  const pos: Record<string, XY> = {};
  const centre: Record<string, XY> = {};
  const rigSize: Record<string, { w: number; h: number }> = {};

  // ---- bottom band: rigs ----
  const widths = input.rigs.map((r) => rigWidth(r.devices.length));
  const totalRigW = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * RIG_GAP;
  let cursor = -totalRigW / 2;
  const rigTargets = input.rigs.map((r, i) => {
    const tx = cursor + widths[i] / 2;
    cursor += widths[i] + RIG_GAP;
    const p = prev?.pos[r.id];
    const pw = prev?.rigSize[r.id]?.w;
    return { id: r.id, r: widths[i] / 2 + RIG_GAP / 2, tx, seed: p && pw ? p.x + pw / 2 : undefined };
  });
  const rigX = settleBand(rigTargets);

  // ---- top band: sessions ----
  const n = input.sessions.length;
  const span = Math.max((n - 1) * SESSION_SPACING, Math.min(totalRigW * 0.7, (n - 1) * SESSION_SPACING * 1.6));
  const sessionTargets = input.sessions.map((id, i) => {
    const p = prev?.pos[id];
    return { id, r: SESSION_W / 2 + 8, tx: n === 1 ? 0 : -span / 2 + (i * span) / (n - 1), seed: p ? p.x + SESSION_W / 2 : undefined };
  });
  const sessionX = settleBand(sessionTargets);

  const sessionY = 0;
  for (const id of input.sessions) {
    pos[id] = { x: sessionX[id] - SESSION_W / 2, y: sessionY };
    centre[id] = { x: sessionX[id], y: sessionY + 44 };
  }

  const xs = input.sessions.map((id) => sessionX[id]);
  const minX = xs.length ? Math.min(...xs) - SESSION_W / 2 : -SESSION_W / 2;
  const maxX = xs.length ? Math.max(...xs) + SESSION_W / 2 : SESSION_W / 2;
  const cloud = {
    x: minX - CLOUD_PAD_X,
    y: sessionY - CLOUD_PAD_TOP,
    w: maxX - minX + CLOUD_PAD_X * 2,
    h: SESSION_H + CLOUD_PAD_TOP + CLOUD_PAD_BOTTOM,
  };

  const rigY = cloud.y + cloud.h + BAND_GAP;
  input.rigs.forEach((r, i) => {
    const w = widths[i];
    const x = rigX[r.id] - w / 2;
    pos[r.id] = { x, y: rigY };
    rigSize[r.id] = { w, h: RIG_H };
    r.devices.forEach((d, j) => {
      const dx = deviceSlotX(j, r.devices.length, w);
      pos[d] = { x: dx, y: RIG_DEVICE_Y };
      centre[d] = { x: x + dx + 74, y: rigY + RIG_DEVICE_Y + 56 };
    });
    if (r.camera) {
      const cx = (w - CAMERA_W) / 2;
      pos[r.camera] = { x: cx, y: RIG_CAMERA_Y };
      centre[r.camera] = { x: x + w / 2, y: rigY + RIG_CAMERA_Y + 22 };
    }
  });

  return { pos, rigSize, cloud, centre };
}

/** Pull the layout input out of the graph: sessions by created_at, rigs by id, devices by bench order. */
export function layoutInputFrom(nodes: Record<string, GNode>): LayoutInput {
  const all = Object.values(nodes);
  const sessions = all
    .filter((n) => n.kind === "session")
    .sort((a, b) => Number(a.data.created_at ?? 0) - Number(b.data.created_at ?? 0) || a.id.localeCompare(b.id))
    .map((n) => n.id);
  const rigs = all
    .filter((n) => n.kind === "rig")
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((r) => ({
      id: r.id,
      devices: all
        .filter((n) => n.kind === "device" && n.parent === r.id)
        .sort((a, b) => Number(a.data.order ?? 0) - Number(b.data.order ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }))
        .map((n) => n.id),
      camera: all.find((n) => n.kind === "camera" && n.parent === r.id)?.id,
    }));
  return { sessions, rigs };
}
