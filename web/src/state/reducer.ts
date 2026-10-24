// The one store (FRONTEND §1): a pure reducer over FarmEvents, snapshotted by graph_snapshot.
// Replay and the timeline scrubber run this same reducer over buffered events.
import { ids, type AssertionResult, type FarmEvent, type GEdge, type GNode, type RunState } from "./types";

export interface Message {
  source: "user" | "devin";
  text: string;
  ts: number;
}

export type VerdictTone = "pass" | "fail" | "self";

export interface Verdict {
  verify_id: string;
  tone: VerdictTone;
  results: AssertionResult[];
  evidence_id?: string;
  at: number;
}

export interface DeviceRuntime {
  run?: { run_id: string; state: RunState; at: number };
  logs: { ts: number; text: string }[];
  verifying?: { verify_id: string; since: number };
  lastVerdict?: Verdict;
}

export interface Toast {
  id: string;
  nodeId: string;
  tone: VerdictTone | "info";
  text: string;
  at: number;
}

export type Connection = "connecting" | "open" | "lost";

export interface FarmState {
  nodes: Record<string, GNode>;
  edges: Record<string, GEdge>;
  /** Latest event timestamp (Unix s). Timers are computed against this so replays stay consistent. */
  now: number;
  messages: Record<string, Message[]>; // by session node id
  devices: Record<string, DeviceRuntime>; // by device node id
  rigHistory: Record<string, { ts: number; temp_c: number; load1: number }[]>; // by rig node id
  toasts: Toast[];
  connection: Connection;
  /** The control plane said its feed is mock (graph_snapshot.mode). */
  feedMock: boolean;
}

export type Action =
  | { type: "event"; event: FarmEvent }
  | { type: "connection"; status: Connection }
  | { type: "dismissToast"; id: string }
  | { type: "reset" };

export const MAX_LOGS = 200;
export const MAX_MESSAGES = 50;
export const MAX_HISTORY = 360; // 30 min at 5 s
export const MAX_TOASTS = 4;

export const initialState: FarmState = {
  nodes: {},
  edges: {},
  now: 0,
  messages: {},
  devices: {},
  rigHistory: {},
  toasts: [],
  connection: "connecting",
  feedMock: false,
};

/** Primary line for a session: the ticket (clean), not the raw Devin title ("farm pico-blink s-1a2b3c4d"). */
export const sessionName = (title: string, ticketId: unknown): string => (typeof ticketId === "string" && ticketId ? ticketId : title);

const hasMeasurement = (r: AssertionResult) => r.measured !== undefined && r.measured !== null;

/** Red only when the camera measured a contradiction; green only when every camera check measured a pass.
 *  Anything the camera couldn't see, or that is only self-reported, is amber. */
export function verdictTone(results: AssertionResult[]): VerdictTone {
  const camera = results.filter((r) => !r.self_reported);
  if (camera.some((r) => !r.passed && hasMeasurement(r))) return "fail";
  if (camera.length === 0 || camera.some((r) => !hasMeasurement(r) || !r.passed)) return "self";
  if (results.some((r) => r.self_reported && !r.passed)) return "self";
  return "pass";
}

export function verdictText(results: AssertionResult[]): string {
  const bad = results.find((r) => !r.passed && !r.self_reported) ?? results.find((r) => !r.passed);
  if (bad) return `${bad.type} ✗${bad.detail ? ` ${bad.detail}` : ""}`;
  const measured = results.filter((r) => !r.self_reported);
  if (measured.length === 0) return `${results.map((r) => r.type).join(", ")}: self-reported only`;
  return `${measured.map((r) => r.type).join(", ")} ✓ confirmed by camera`;
}

function runtime(s: FarmState, id: string): DeviceRuntime {
  return s.devices[id] ?? { logs: [] };
}

function pushToast(toasts: Toast[], t: Toast): Toast[] {
  return [...toasts, t].slice(-MAX_TOASTS);
}

function patchNode(s: FarmState, id: string, patch: Partial<GNode> & { data?: Record<string, unknown> }): Record<string, GNode> {
  const cur = s.nodes[id];
  if (!cur) return s.nodes;
  return { ...s.nodes, [id]: { ...cur, ...patch, data: { ...cur.data, ...(patch.data ?? {}) } } };
}

function withoutEdge(edges: Record<string, GEdge>, id: string): Record<string, GEdge> {
  if (!(id in edges)) return edges;
  const next = { ...edges };
  delete next[id];
  return next;
}

/** Renumber the queue edges of one device after someone leaves or is granted. */
function renumberQueue(edges: Record<string, GEdge>, deviceId: string): Record<string, GEdge> {
  const q = Object.values(edges)
    .filter((e) => e.kind === "queue" && e.target === deviceId)
    .sort((a, b) => (a.data?.position ?? 0) - (b.data?.position ?? 0));
  if (q.length === 0) return edges;
  const next = { ...edges };
  q.forEach((e, i) => (next[e.id] = { ...e, data: { ...e.data, position: i + 1 } }));
  return next;
}

export function applyEvent(s: FarmState, ev: FarmEvent): FarmState {
  const now = Math.max(s.now, ev.data.ts ?? 0);
  s = { ...s, now };

  switch (ev.name) {
    case "graph_snapshot": {
      const nodes: Record<string, GNode> = {};
      const edges: Record<string, GEdge> = {};
      ev.data.nodes.forEach((n) => (nodes[n.id] = n.kind === "session" ? { ...n, label: sessionName(n.label, n.data.ticket_id) } : n));
      ev.data.edges.forEach((e) => (edges[e.id] = e));
      return { ...s, nodes, edges, feedMock: ev.data.mode === "mock" };
    }

    case "rig_health": {
      const id = ids.rig(ev.data.rig_id);
      const { temp_c, load1, mem_free_mb, throttled, camera_ok, verifier_online } = ev.data;
      const hist = [...(s.rigHistory[id] ?? []), { ts: ev.data.ts, temp_c, load1 }].slice(-MAX_HISTORY);
      let nodes = patchNode(s, id, {
        status: "online",
        data: { temp_c, load1, mem_free_mb, throttled, camera_ok, verifier_online, last_seen: ev.data.ts },
      });
      const cam = ids.camera(ev.data.rig_id);
      if (nodes[cam]) nodes = { ...nodes, [cam]: { ...nodes[cam], status: camera_ok ? "ok" : "down" } };
      return { ...s, nodes, rigHistory: { ...s.rigHistory, [id]: hist } };
    }

    case "device": {
      const id = ids.device(ev.data.rig_id, ev.data.device);
      return {
        ...s,
        nodes: patchNode(s, id, {
          status: ev.data.status,
          data: { holder: ev.data.holder ?? null, queue_depth: ev.data.queue_depth },
        }),
      };
    }

    case "lease": {
      const d = ev.data;
      const deviceId = ids.device(d.rig_id, d.device);
      const sessionId = ids.sessionFromHolder(d.holder);
      let edges = s.edges;
      let toasts = s.toasts;
      let devices = s.devices;
      switch (d.event) {
        case "queued":
          edges = {
            ...edges,
            [ids.queue(d.lease_id)]: {
              id: ids.queue(d.lease_id),
              kind: "queue",
              source: sessionId,
              target: deviceId,
              data: { position: d.position ?? 1 },
            },
          };
          break;
        case "granted":
          if (devices[deviceId]) devices = { ...devices, [deviceId]: { ...devices[deviceId], run: undefined, logs: [], verifying: undefined } };
          edges = withoutEdge(edges, ids.queue(d.lease_id));
          edges = renumberQueue(edges, deviceId);
          edges = {
            ...edges,
            [ids.lease(d.lease_id)]: {
              id: ids.lease(d.lease_id),
              kind: "lease",
              source: sessionId,
              target: deviceId,
              data: { token: d.token, expires_at: d.expires_at },
            },
          };
          break;
        case "renewed": {
          const e = edges[ids.lease(d.lease_id)];
          if (e) edges = { ...edges, [e.id]: { ...e, data: { ...e.data, expires_at: d.expires_at ?? e.data?.expires_at } } };
          break;
        }
        case "released":
        case "expired":
        case "revoked":
          edges = withoutEdge(edges, ids.lease(d.lease_id));
          edges = withoutEdge(edges, ids.queue(d.lease_id));
          edges = renumberQueue(edges, deviceId);
          if (d.event !== "released") {
            toasts = pushToast(toasts, {
              id: `lease-${d.lease_id}-${d.event}`,
              nodeId: deviceId,
              tone: "info",
              text: `${d.device}: lease ${d.event} (${d.holder})`,
              at: d.ts,
            });
          }
          break;
      }
      return { ...s, edges, toasts, devices };
    }

    case "run": {
      const id = ids.device(ev.data.rig_id, ev.data.device);
      const rt = runtime(s, id);
      const newRun = rt.run?.run_id !== ev.data.run_id;
      return {
        ...s,
        devices: {
          ...s.devices,
          [id]: { ...rt, logs: newRun ? [] : rt.logs, run: { run_id: ev.data.run_id, state: ev.data.state, at: ev.data.ts } },
        },
      };
    }

    case "log": {
      const id = ids.device(ev.data.rig_id, ev.data.device);
      const rt = runtime(s, id);
      const logs = [...rt.logs, { ts: ev.data.ts, text: ev.data.text }].slice(-MAX_LOGS);
      return { ...s, devices: { ...s.devices, [id]: { ...rt, logs } } };
    }

    case "verify": {
      const d = ev.data;
      const id = ids.device(d.rig_id, d.device);
      const rt = runtime(s, id);
      if (d.state === "pending") {
        return { ...s, devices: { ...s.devices, [id]: { ...rt, verifying: { verify_id: d.verify_id, since: d.ts } } } };
      }
      const results = d.results ?? [];
      const tone: VerdictTone = d.state === "error" ? "self" : verdictTone(results); // an error measured nothing
      const lastVerdict: Verdict = { verify_id: d.verify_id, tone, results, at: d.ts };
      const text = d.state === "error" ? `${d.device}: verify error` : `${d.device}: ${verdictText(results)}`;
      return {
        ...s,
        devices: { ...s.devices, [id]: { ...rt, verifying: undefined, lastVerdict } },
        toasts: pushToast(s.toasts, { id: `verify-${d.verify_id}`, nodeId: id, tone, text, at: d.ts }),
      };
    }

    case "evidence": {
      const id = ids.device(ev.data.rig_id, ev.data.device);
      const rt = runtime(s, id);
      if (!rt.lastVerdict) return s;
      return { ...s, devices: { ...s.devices, [id]: { ...rt, lastVerdict: { ...rt.lastVerdict, evidence_id: ev.data.evidence_id } } } };
    }

    case "session": {
      const d = ev.data;
      const id = ids.session(d.farm_id);
      const existing = s.nodes[id];
      const node: GNode = {
        id,
        kind: "session",
        label: sessionName(d.title, d.ticket_id ?? existing?.data.ticket_id),
        status: d.status,
        data: {
          ...(existing?.data ?? {}),
          farm_id: d.farm_id,
          ticket_id: d.ticket_id ?? existing?.data.ticket_id,
          devin_session_id: d.devin_session_id,
          node_name: d.node_name ?? null,
          acus: d.acus,
          url: d.url,
          created_at: d.created_at ?? existing?.data.created_at ?? d.ts,
        },
      };
      return { ...s, nodes: { ...s.nodes, [id]: node } };
    }

    case "session_message": {
      const id = ids.session(ev.data.farm_id);
      const list = [...(s.messages[id] ?? []), { source: ev.data.source, text: ev.data.text, ts: ev.data.ts }].slice(-MAX_MESSAGES);
      return { ...s, messages: { ...s.messages, [id]: list } };
    }
  }
  return s;
}

export function reducer(s: FarmState, a: Action): FarmState {
  switch (a.type) {
    case "event":
      return applyEvent(s, a.event);
    case "connection":
      return { ...s, connection: a.status };
    case "dismissToast":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case "reset":
      return { ...initialState, connection: s.connection };
  }
}

/** Fold a list of events from scratch (replay, timeline scrubbing). */
export function foldEvents(events: FarmEvent[]): FarmState {
  return events.reduce(applyEvent, { ...initialState, connection: "open" as Connection });
}
