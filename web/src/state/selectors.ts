// Derived views over FarmState shared by the map and the drawers.
import type { FarmState } from "./reducer";
import type { GEdge, GNode } from "./types";

export const SESSION_HUES = ["--s0", "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"] as const;

export function sessionsOrdered(s: FarmState): GNode[] {
  return Object.values(s.nodes)
    .filter((n) => n.kind === "session")
    .sort((a, b) => Number(a.data.created_at ?? 0) - Number(b.data.created_at ?? 0) || a.id.localeCompare(b.id));
}

// Session identity: a letter (A, B, C…) and a hue, assigned once in creation order and kept for the
// life of the page, so a session never changes colour when others come and go.
const slots = new Map<string, number>();

/** Give every session a slot, oldest first. Idempotent; called by the store on each state. */
export function syncSessionSlots(sessions: GNode[]): void {
  for (const n of sessions) if (!slots.has(n.id)) slots.set(n.id, slots.size);
}

function slotOf(sessionId: string): number {
  if (!slots.has(sessionId)) slots.set(sessionId, slots.size);
  return slots.get(sessionId)!;
}

/** Hue order chosen so neighbours (A, B, C) contrast: violet, orange, cyan, pink, gold, magenta, tan, lavender. */
const HUE_ORDER = [0, 2, 4, 5, 3, 1, 6, 7];

export function sessionHue(sessionId: string): string {
  return `var(${SESSION_HUES[HUE_ORDER[slotOf(sessionId) % HUE_ORDER.length]]})`;
}

export function sessionLetter(sessionId: string): string {
  const i = slotOf(sessionId);
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : "");
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
