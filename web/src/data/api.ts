// farm-control operator API client (CONTRACTS C10). Public builds never call the mutating routes.
export const PUBLIC = import.meta.env.VITE_PUBLIC === "1";
const base = PUBLIC ? "/pub" : "/api";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    const msg = body?.error?.message ?? `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) => j<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  graphUrl: `${base}/graph`,
  eventsUrl: `${base}/events`,
  graph: () => j<import("../state/types").Graph>(`${base}/graph`),
  budget: () => j<{ acus_used: number; acus_cap: number; sessions_live: number }>("/api/budget"),
  messages: (farmId: string) => j<{ source: "user" | "devin"; text: string; ts: number }[]>(`/api/sessions/${farmId}/messages`),
  createSession: (body: { ticket_id: string; device_hint?: string; max_acu?: number; extra_prompt?: string }) =>
    post<{ farm_id: string; devin_session_id: string }>("/api/sessions", body),
  sendMessage: (farmId: string, text: string) => post<unknown>(`/api/sessions/${farmId}/message`, { text }),
  stopSession: (farmId: string) => post<unknown>(`/api/sessions/${farmId}/stop`),
  poll: (rigId: string, device: string) => post<{ state: unknown; snapshot_url: string }>(`/api/rigs/${rigId}/devices/${device}/poll`),
  /** C3 admin, proxied by control. */
  maintenance: (rigId: string, on: boolean) => post<unknown>(`/api/rigs/${rigId}/admin/maintenance`, { on }),
  resetDevice: (rigId: string, device: string) => post<unknown>(`/api/rigs/${rigId}/admin/devices/${device}/reset`),
  revokeLease: (rigId: string, leaseId: string) => post<unknown>(`/api/rigs/${rigId}/admin/leases/${leaseId}/revoke`),
  /** Cropped ROI snapshot, ≤ 1/s (C3, proxied by control). */
  snapshotUrl: (rigId: string, device: string, bust: number) => `${base}/rigs/${rigId}/devices/${device}/snapshot.jpg?t=${bust}`,
  /** Not in C10 yet: tickets list for the New session modal. Falls back to a static list. */
  tickets: () => j<{ id: string; title: string; device_type: string }[]>("/api/tickets"),
};
