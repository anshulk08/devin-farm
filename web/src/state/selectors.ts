// Derived views over FarmState shared by the map and the drawers.
import type { FarmState } from "./reducer";
import type { GEdge, GNode } from "./types";

export const SESSION_HUES = ["--s0", "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"] as const;

export function sessionsOrdered(s: FarmState): GNode[] {
  return Object.values(s.nodes)
    .filter((n) => n.kind === "session")
    .sort((a, b) => Number(a.data.created_at ?? 0) - Number(b.data.created_at ?? 0) || a.id.localeCompare(b.id));
}

/** Stable hue per session: hashed from the id so it never changes when others come and go. */
export function sessionHue(sessionId: string): string {
  let h = 0;
  for (const c of sessionId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(${SESSION_HUES[h % SESSION_HUES.length]})`;
}

export function rigs(s: FarmState): GNode[] {
  return Object.values(s.nodes).filter((n) => n.kind === "rig").sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Devices of a rig in bench order (data.order), else by id. */
export function devicesOf(s: FarmState, rigId: string): GNode[] {
  return Object.values(s.nodes)
    .filter((n) => n.kind === "device" && n.parent === rigId)
    .sort((a, b) => Number(a.data.order ?? 0) - Number(b.data.order ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function cameraOf(s: FarmState, rigId: string): GNode | undefined {
  return Object.values(s.nodes).find((n) => n.kind === "camera" && n.parent === rigId);
}

export function leaseOn(s: FarmState, deviceId: string): GEdge | undefined {
  return Object.values(s.edges).find((e) => e.kind === "lease" && e.target === deviceId);
}

export function queueOn(s: FarmState, deviceId: string): GEdge[] {
  return Object.values(s.edges)
    .filter((e) => e.kind === "queue" && e.target === deviceId)
    .sort((a, b) => (a.data?.position ?? 0) - (b.data?.position ?? 0));
}

export function edgesOfSession(s: FarmState, sessionId: string): { leases: GEdge[]; queued: GEdge[] } {
  const mine = Object.values(s.edges).filter((e) => e.source === sessionId);
  return { leases: mine.filter((e) => e.kind === "lease"), queued: mine.filter((e) => e.kind === "queue") };
}

/** "3:12" from seconds; "0:00" floor. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Split a device node id into its rig and device names. */
export function splitDeviceId(id: string): { rigId: string; device: string } {
  const [rigId, device] = id.replace(/^device:/, "").split("/");
  return { rigId, device };
}
