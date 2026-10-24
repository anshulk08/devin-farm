// FarmState → React Flow nodes/edges. Pure; the node `data` objects hold only what the bubble draws,
// so `stabilize` can keep object identity for unchanged nodes and memoised node components skip re-rendering.
import type { Edge, Node } from "@xyflow/react";
import type { FarmState, VerdictTone } from "../state/reducer";
import type { GNode } from "../state/types";
import { ids } from "../state/types";
import { sessionHue, sessionLetter, splitDeviceId } from "../state/selectors";
import type { Layout } from "./layout";
import {
  CAMERA_H,
  CAMERA_W,
  DEVICE_D,
  DEVICE_H,
  DEVICE_W,
  PORT_STUB,
  RIG_DEVICE_Y,
  SESSION_H,
  SESSION_W,
} from "./geometry";

export type BoardType = "pico" | "unoq" | "other";

export interface SessionData extends Record<string, unknown> {
  title: string;
  initial: string;
  shortId: string;
  status: string;
  hue: string;
  acus: number | null;
  selected: boolean;
}

export interface RigData extends Record<string, unknown> {
  label: string;
  model: string;
  online: boolean;
  tempC: number | null;
  load1: number | null;
  cameraOk: boolean | null;
  throttled: boolean;
  mock: boolean;
  maintenance: boolean;
  lastSeen: number | null;
  /** Port stubs (relative x,y) for the attached edges, one per device. */
  ports: { id: string; x: number; y: number }[];
  w: number;
  h: number;
  selected: boolean;
}

export interface DeviceData extends Record<string, unknown> {
  label: string;
  rigId: string;
  device: string;
  board: BoardType;
  status: string;
  /** Holder session hue, if leased. */
  hue: string | null;
  holderShort: string | null;
  verifying: boolean;
  runState: string | null;
  verdictId: string | null;
  verdictTone: VerdictTone | null;
  /** Live thumbnails only in live mode and not while scrubbing history. */
  liveThumb: boolean;
  selected: boolean;
}

export interface CameraData extends Record<string, unknown> {
  label: string;
  ok: boolean;
  /** Scan arcs: angle (deg, 0 = right, clockwise) from the lens toward each device being verified. */
  scans: { id: string; angle: number }[];
  selected: boolean;
}

export interface CloudData extends Record<string, unknown> {
  count: number;
}

export type MapNode =
  | Node<SessionData, "session">
  | Node<RigData, "rig">
  | Node<DeviceData, "device">
  | Node<CameraData, "camera">
  | Node<CloudData, "cloud">;

export interface LeaseEdgeData extends Record<string, unknown> {
  hue: string;
  token: number | null;
  expiresAt: number | null;
  active: boolean;
  /** Ghost of a removed lease, drawn retracting toward the session. */
  retracting?: boolean;
  /** Existed when the map first loaded: skip the draw-in. */
  settled?: boolean;
}
export interface QueueEdgeData extends Record<string, unknown> {
  hue: string;
  position: number;
  leaving?: boolean;
}
export interface WatchesEdgeData extends Record<string, unknown> {
  active: boolean;
  offline: boolean;
}
export interface AttachedEdgeData extends Record<string, unknown> {
  offline: boolean;
}

export type MapEdge =
  | Edge<LeaseEdgeData, "lease">
  | Edge<QueueEdgeData, "queue">
  | Edge<WatchesEdgeData, "watches">
  | Edge<AttachedEdgeData, "attached">;

const ACTIVE_RUN = new Set(["fetching", "building", "running"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function boardOf(n: GNode): BoardType {
  const t = String(n.data.type ?? n.label).toLowerCase();
  if (t.startsWith("pico")) return "pico";
  if (t.startsWith("unoq") || t.startsWith("uno")) return "unoq";
  return "other";
}

/** "s-1a2b3c4d" → "1a2b". */
export function shortFarmId(id: string): string {
  return id.replace(/^session:/, "").replace(/^devin-/, "").replace(/^s-/, "").slice(0, 4);
}

/** Who holds a device: the lease edge's session, else the device's reported holder. */
export function holderOf(s: FarmState, deviceId: string): string | null {
  for (const e of Object.values(s.edges)) if (e.kind === "lease" && e.target === deviceId) return e.source;
  const h = s.nodes[deviceId]?.data.holder;
  return typeof h === "string" && h ? ids.sessionFromHolder(h) : null;
}

export function isDeviceActive(s: FarmState, deviceId: string): boolean {
  const rt = s.devices[deviceId];
  return !!rt && (!!rt.verifying || (!!rt.run && ACTIVE_RUN.has(rt.run.state)));
}

export interface BuildOptions {
  liveThumbs: boolean;
  selectedId: string | null;
}

export function buildNodes(s: FarmState, layout: Layout, opts: BuildOptions): MapNode[] {
  const out: MapNode[] = [];
  const sel = (id: string) => opts.selectedId === id;
  const sessions = Object.values(s.nodes).filter((n) => n.kind === "session");

  out.push({
    id: "cloud",
    type: "cloud",
    position: { x: layout.cloud.x, y: layout.cloud.y },
    width: layout.cloud.w,
    height: layout.cloud.h,
    data: { count: sessions.length },
    selectable: false,
    focusable: false,
    draggable: false,
    zIndex: -1,
  });

  for (const n of sessions) {
    const p = layout.pos[n.id];
    if (!p) continue;
    out.push({
      id: n.id,
      type: "session",
      position: p,
      width: SESSION_W,
      height: SESSION_H,
      ariaLabel: `Session ${n.label}, ${n.status}`,
      data: {
        title: n.label,
        initial: sessionLetter(n.id),
        shortId: shortFarmId(String(n.data.farm_id ?? n.id)),
        status: n.status,
        hue: sessionHue(n.id),
        acus: num(n.data.acus),
        selected: sel(n.id),
      },
    });
  }

  for (const r of Object.values(s.nodes).filter((n) => n.kind === "rig")) {
    const p = layout.pos[r.id];
    const size = layout.rigSize[r.id];
    if (!p || !size) continue;
    const ports = Object.values(s.nodes)
      .filter((d) => d.kind === "device" && d.parent === r.id && layout.pos[d.id])
      .map((d) => ({ id: d.id, x: layout.pos[d.id].x + (DEVICE_W - DEVICE_D) / 2 - PORT_STUB, y: RIG_DEVICE_Y + DEVICE_D / 2 }));
    out.push({
      id: r.id,
      type: "rig",
      position: p,
      width: size.w,
      height: size.h,
      ariaLabel: `Rig ${r.label}, ${r.status}`,
      data: {
        label: r.label,
        model: String(r.data.model ?? ""),
        online: r.status !== "offline",
        tempC: num(r.data.temp_c),
        load1: num(r.data.load1),
        cameraOk: typeof r.data.camera_ok === "boolean" ? r.data.camera_ok : null,
        throttled: r.data.throttled === true,
        mock: r.data.mock === true,
        maintenance: r.data.maintenance === true,
        lastSeen: num(r.data.last_seen),
        ports,
        w: size.w,
        h: size.h,
        selected: sel(r.id),
      },
    });

    for (const d of Object.values(s.nodes).filter((n) => n.kind === "device" && n.parent === r.id)) {
      const dp = layout.pos[d.id];
      if (!dp) continue;
      const holder = d.status === "leased" || d.status === "resetting" ? holderOf(s, d.id) : null;
      const rt = s.devices[d.id];
      const { rigId, device } = splitDeviceId(d.id);
      out.push({
        id: d.id,
        type: "device",
        parentId: r.id,
        extent: "parent",
        position: dp,
        width: DEVICE_W,
        height: DEVICE_H,
        ariaLabel: `Device ${d.label}, ${d.status}`,
        data: {
          label: d.label,
          rigId,
          device,
          board: boardOf(d),
          status: d.status,
          hue: holder && d.status === "leased" ? sessionHue(holder) : null,
          holderShort: holder ? shortFarmId(holder) : null,
          verifying: !!rt?.verifying,
          runState: rt?.run?.state ?? null,
          verdictId: rt?.lastVerdict?.verify_id ?? null,
          verdictTone: rt?.lastVerdict?.tone ?? null,
          liveThumb: opts.liveThumbs && d.status !== "offline",
          selected: sel(d.id),
        },
      });
    }

    const cam = Object.values(s.nodes).find((n) => n.kind === "camera" && n.parent === r.id);
    if (cam && layout.pos[cam.id]) {
      const c = layout.centre[cam.id];
      const scans = Object.values(s.edges)
        .filter((e) => e.kind === "watches" && e.source === cam.id && s.devices[e.target]?.verifying && layout.centre[e.target])
        .map((e) => {
          const t = layout.centre[e.target];
          return { id: e.target, angle: (Math.atan2(t.y - c.y, t.x - c.x) * 180) / Math.PI };
        });
      out.push({
        id: cam.id,
        type: "camera",
        parentId: r.id,
        extent: "parent",
        position: layout.pos[cam.id],
        width: CAMERA_W,
        height: CAMERA_H,
        ariaLabel: `Camera ${cam.label}, ${cam.status}`,
        data: { label: cam.label, ok: cam.status !== "down" && cam.status !== "offline", scans, selected: sel(cam.id) },
      });
    }
  }
  // Bubbles have fixed sizes. Declaring them as `measured` keeps React Flow's handle bounds across data updates;
  // without it every new node object resets them and the node's edges blink out until it is re-measured.
  return out.map((n) => ({ ...n, measured: { width: n.width, height: n.height } }));
}

export function buildEdges(s: FarmState, nodeIds: Set<string>, settled: Set<string>): MapEdge[] {
  const out: MapEdge[] = [];
  for (const e of Object.values(s.edges)) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    switch (e.kind) {
      case "lease":
        out.push({
          id: e.id,
          type: "lease",
          source: e.source,
          target: e.target,
          sourceHandle: "out",
          targetHandle: "in",
          data: {
            hue: sessionHue(e.source),
            token: e.data?.token ?? null,
            expiresAt: e.data?.expires_at ?? null,
            active: isDeviceActive(s, e.target),
            settled: settled.has(e.id),
          },
        });
        break;
      case "queue":
        out.push({
          id: e.id,
          type: "queue",
          source: e.source,
          target: e.target,
          sourceHandle: "out",
          targetHandle: "in",
          data: { hue: sessionHue(e.source), position: e.data?.position ?? 1 },
        });
        break;
      case "watches":
        out.push({
          id: e.id,
          type: "watches",
          source: e.source,
          target: e.target,
          sourceHandle: "out",
          targetHandle: "cam",
          data: { active: !!s.devices[e.target]?.verifying, offline: s.nodes[e.target]?.status === "offline" },
        });
        break;
      case "attached":
        out.push({
          id: e.id,
          type: "attached",
          source: e.source,
          target: e.target,
          sourceHandle: `port:${e.target}`,
          targetHandle: "usb",
          data: { offline: s.nodes[e.target]?.status === "offline" || s.nodes[e.source]?.status === "offline" },
        });
        break;
    }
  }
  // Lines that matter most draw last (on top): attached < watches < queue < lease.
  const rank = { attached: 0, watches: 1, queue: 2, lease: 3 } as const;
  return out.sort((a, b) => rank[a.type!] - rank[b.type!] || a.id.localeCompare(b.id));
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

/** Reuse previous objects whose content didn't change, so React Flow and memo() skip them. */
export function stabilize<T extends { id: string; data?: Record<string, unknown> }>(prev: Map<string, T>, next: T[]): T[] {
  return next.map((n) => {
    const p = prev.get(n.id);
    if (!p) return n;
    const { data: pd, ...pr } = p;
    const { data: nd, ...nr } = n;
    if (shallowEqual(pr as Record<string, unknown>, nr as Record<string, unknown>) && shallowEqual(pd ?? {}, nd ?? {})) return p;
    return n;
  });
}

