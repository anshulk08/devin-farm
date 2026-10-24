// Pure view-model for the dashboard: what each row and card says, derived from FarmState.
import type { FarmState, VerdictTone } from "../state/reducer";
import type { GNode } from "../state/types";
import { clock, devicesOf, edgesOfSession, leaseOn, queueOn, rigs, sessionHue, sessionLetter, sessionsOrdered } from "../state/selectors";
import { boardOf, holderOf, type BoardType } from "../map/build";

export type PillKind = "run" | "wait" | "idle" | "bad";
export interface Pill {
  kind: PillKind;
  label: string;
}

export interface SessionRow {
  id: string;
  letter: string;
  hue: string;
  title: string;
  pill: Pill;
  /** "tok 17 · 3:12 left" or "#1 in line (pico-1)" */
  meta: string;
  short: string; // mobile: "3:12 left" / "#1 in line"
}

const SESSION_PILL: Record<string, Pill> = {
  running: { kind: "run", label: "Running" },
  working: { kind: "run", label: "Running" },
  blocked: { kind: "wait", label: "Waiting for you" },
  waiting: { kind: "wait", label: "Waiting for you" },
  suspended: { kind: "wait", label: "Suspended" },
  joining: { kind: "idle", label: "Joining" },
  starting: { kind: "idle", label: "Joining" },
  finished: { kind: "idle", label: "Finished" },
  stopped: { kind: "idle", label: "Stopped" },
  expired: { kind: "idle", label: "Expired" },
  error: { kind: "bad", label: "Error" },
  failed: { kind: "bad", label: "Error" },
};

const left = (expires: number | undefined, now: number) => (expires == null ? null : `${clock(expires - now)} left`);
const deviceName = (id: string) => id.replace(/^device:[^/]+\//, "");

export function sessionRows(s: FarmState, now: number): SessionRow[] {
  return sessionsOrdered(s).map((n) => {
    const { leases, queued } = edgesOfSession(s, n.id);
    let pill = SESSION_PILL[n.status] ?? { kind: "idle" as const, label: n.status.charAt(0).toUpperCase() + n.status.slice(1) };
    let meta = "No board yet";
    let short = "No board";
    if (leases.length) {
      const l = leases[0];
      const t = left(l.data?.expires_at, now);
      meta = [l.data?.token != null ? `tok ${l.data.token}` : null, t].filter(Boolean).join(" · ");
      short = t ?? deviceName(l.target);
      if (leases.length > 1) meta += `  +${leases.length - 1}`;
    } else if (queued.length) {
      const q = queued[0];
      meta = `#${q.data?.position ?? 1} in line (${deviceName(q.target)})`;
      short = `#${q.data?.position ?? 1} in line`;
      if (pill.kind === "run") pill = { kind: "wait", label: "Queued" };
    } else if (pill.label === "Finished" || pill.label === "Stopped") {
      meta = short = "Released";
    }
    return { id: n.id, letter: sessionLetter(n.id), hue: sessionHue(n.id), title: n.label, pill, meta, short };
  });
}

export function counts(s: FarmState): { sessions: number; active: number; queued: number } {
  const ss = sessionsOrdered(s);
  let active = 0;
  let queued = 0;
  for (const n of ss) {
    const { leases, queued: q } = edgesOfSession(s, n.id);
    if (leases.length) active++;
    else if (q.length) queued++;
  }
  return { sessions: ss.length, active, queued };
}

export interface DeviceCard {
  id: string;
  name: string;
  board: BoardType;
  offline: boolean;
  holder: { id: string; letter: string; hue: string } | null;
  subtitle: string;
  pill: Pill | null;
  /** Plain status word shown instead of a pill (free / offline), as in the reference. */
  word: string | null;
  meta: string;
  queue: number;
  verdict: VerdictTone | null;
  verifying: boolean;
  dot: "run" | "idle" | "off";
}

export interface RigCard {
  id: string;
  name: string;
  mock: boolean;
  online: boolean;
  temp: string;
  load: string;
  cam: boolean | null;
  devices: DeviceCard[];
}

const RUN_PILL: Record<string, Pill> = {
  queued: { kind: "idle", label: "Run queued" },
  fetching: { kind: "run", label: "Fetching" },
  building: { kind: "run", label: "Building" },
  running: { kind: "run", label: "Running" },
  failed: { kind: "bad", label: "Run failed" },
  stopped: { kind: "idle", label: "Stopped" },
};

function deviceCard(s: FarmState, n: GNode, rigMock: boolean, now: number): DeviceCard {
  const rt = s.devices[n.id];
  const holderId = n.status === "leased" ? holderOf(s, n.id) : null;
  const holderNode = holderId ? s.nodes[holderId] : undefined;
  const lease = leaseOn(s, n.id);
  const offline = n.status === "offline";
  const base = {
    id: n.id,
    name: n.label,
    board: boardOf(n),
    offline,
    holder: holderId ? { id: holderId, letter: sessionLetter(holderId), hue: sessionHue(holderId) } : null,
    queue: queueOn(s, n.id).length,
    verdict: rt?.lastVerdict?.tone ?? null,
    verifying: !!rt?.verifying,
  };
  if (offline) {
    const reason = typeof n.data.reason === "string" ? n.data.reason : null;
    return { ...base, subtitle: rigMock ? "(mock)" : "", pill: null, word: "Offline", meta: reason ? capital(reason) : "Not connected", dot: "off" };
  }
  if (n.status === "resetting") {
    return { ...base, subtitle: "(resetting)", pill: { kind: "wait", label: "Resetting" }, word: null, meta: "Confirming idle on camera", dot: "idle" };
  }
  if (n.status === "leased") {
    const pill = rt?.verifying ? { kind: "run" as const, label: "Verifying" } : rt?.run ? RUN_PILL[rt.run.state] : { kind: "idle" as const, label: "Leased" };
    const t = left(lease?.data?.expires_at, now);
    const meta = [lease?.data?.token != null ? `tok ${lease.data.token}` : null, t].filter(Boolean).join(" · ") || "Leased";
    return { ...base, subtitle: holderNode?.label ?? "", pill, word: null, meta, dot: pill.kind === "run" ? "run" : "idle" };
  }
  // free
  if (rigMock) return { ...base, subtitle: "(mock)", pill: null, word: "Free", meta: "No session", dot: "idle" };
  return { ...base, subtitle: "(idle)", pill: { kind: "idle", label: "Idle" }, word: null, meta: "No session", dot: "idle" };
}

function capital(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function rigCards(s: FarmState, now: number): RigCard[] {
  return rigs(s).map((r) => {
    const d = r.data;
    const mock = !!d.mock;
    const online = r.status !== "offline";
    const num = (v: unknown, digits: number) => (typeof v === "number" && online ? v.toFixed(digits) : "–");
    return {
      id: r.id,
      name: r.label,
      mock,
      online,
      temp: num(d.temp_c, 0),
      load: num(d.load1, 1),
      cam: online && typeof d.camera_ok === "boolean" ? d.camera_ok : null,
      devices: devicesOf(s, r.id).map((n) => deviceCard(s, n, mock, now)),
    };
  });
}
