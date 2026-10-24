// Shapes from docs/CONTRACTS.md (C4, C6, C10) and docs/FRONTEND.md §3.
// Keep this file in lockstep with the contracts; it is the only place the UI defines them.

export type NodeKind = "session" | "rig" | "device" | "camera";
export type EdgeKind = "attached" | "watches" | "lease" | "queue";

export interface GNode {
  id: string; // session:s-1a2b3c4d | rig:rig-1 | device:rig-1/pico-1 | camera:rig-1
  kind: NodeKind;
  parent?: string;
  label: string;
  status: string;
  data: Record<string, unknown>;
}

export interface GEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  data?: { position?: number; token?: number; expires_at?: number };
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** farm-control labels a mock-driver stack "mock" (C10); the UI must not call that Live. */
  mode?: string;
}

// ---- C6 assertion results ----
export interface AssertionResult {
  type: string;
  target?: string;
  passed: boolean;
  measured?: unknown;
  expected?: unknown;
  uncertainty?: Record<string, number>;
  detail?: string;
  self_reported: boolean;
}

// ---- C4 events (rig, re-emitted by control) + control additions ----
interface Base {
  rig_id?: string;
  ts: number;
}

export type DeviceStatus = "free" | "leased" | "resetting" | "offline";
export type LeaseEventKind = "queued" | "granted" | "renewed" | "released" | "expired" | "revoked";
export type RunState = "queued" | "fetching" | "building" | "running" | "failed" | "stopped";
export type SessionStatus = "joining" | "running" | "blocked" | "finished" | "error" | string;

export type FarmEvent =
  | { name: "graph_snapshot"; data: Base & Graph }
  | {
      name: "rig_health";
      data: Base & {
        rig_id: string;
        temp_c: number;
        load1: number;
        mem_free_mb: number;
        throttled: boolean;
        camera_ok: boolean;
        verifier_online: boolean;
      };
    }
  | { name: "device"; data: Base & { rig_id: string; device: string; status: DeviceStatus; holder?: string; queue_depth: number } }
  | {
      name: "lease";
      data: Base & {
        rig_id: string;
        device: string;
        lease_id: string;
        holder: string; // tailnet node name, devin-<farm_id>
        event: LeaseEventKind;
        position?: number;
        token?: number;
        expires_at?: number;
      };
    }
  | { name: "run"; data: Base & { rig_id: string; device: string; run_id: string; state: RunState } }
  | { name: "log"; data: Base & { rig_id: string; device: string; run_id: string; text: string } }
  | {
      name: "verify";
      data: Base & { rig_id: string; device: string; verify_id: string; state: "pending" | "done" | "error"; results?: AssertionResult[] };
    }
  | { name: "evidence"; data: Base & { rig_id: string; device: string; evidence_id: string; passed: boolean } }
  | {
      name: "session";
      data: Base & {
        farm_id: string;
        devin_session_id: string;
        node_name?: string;
        status: SessionStatus;
        acus: number;
        title: string;
        url: string;
        created_at?: number;
        ticket_id?: string;
      };
    }
  | { name: "session_message"; data: Base & { farm_id: string; source: "user" | "devin"; text: string } };

export type FarmEventName = FarmEvent["name"];

// ---- ID helpers (FRONTEND §3) ----
export const ids = {
  session: (farmId: string) => `session:${farmId}`,
  rig: (rigId: string) => `rig:${rigId}`,
  device: (rigId: string, device: string) => `device:${rigId}/${device}`,
  camera: (rigId: string) => `camera:${rigId}`,
  /** Tailnet hostname `devin-<farm_id>` → session node id. */
  sessionFromHolder: (holder: string) => `session:${holder.replace(/^devin-/, "")}`,
  lease: (leaseId: string) => `lease:${leaseId}`,
  queue: (leaseId: string) => `queue:${leaseId}`,
};

export type SourceMode = "live" | "mock" | "replay";
