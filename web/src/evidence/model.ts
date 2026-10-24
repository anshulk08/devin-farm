// Evidence bundle (CONTRACTS C7) and the pure helpers the evidence page renders with.
// No React here, so everything in this file is unit-tested (model.test.ts).
import type { AssertionResult } from "../state/types";

export interface EvidenceFrame {
  /** File name inside the bundle, e.g. "frame-1.jpg". */
  file: string;
  /** Milliseconds since the start of the observation window. */
  t_ms?: number;
  caption?: string;
}

/** C7 evidence.json. `frames`, `sample` and `assertion_text` are optional page-side extras (see README). */
export interface EvidenceBundle {
  evidence_id: string;
  rig_id: string;
  device: string;
  holder: string;
  farm_id: string;
  repo_url: string;
  sha: string;
  run_id: string;
  verify_id: string;
  started_at: number;
  finished_at: number;
  results: AssertionResult[];
  rig: { temp_c: number; throttled: boolean };
  verifier_version: string;
  frames?: EvidenceFrame[];
  /** Files in the bundle (proposed C7 addition, matches farm-control). */
  files?: string[];
  /** True for fixtures and drawings. The page then says so above the fold. */
  sample?: boolean;
}

// ---------- loading ----------

export interface EvidenceSource {
  /** Evidence id from /e/<id>, ?id=, or the fixture name. Null when the URL names none. */
  id: string | null;
  /** URL of evidence.json. */
  jsonUrl: string | null;
  /** Prefix for bundle files (clip.mp4, frame-*.jpg), always ending in "/". */
  baseUrl: string | null;
  fixture: boolean;
}

export const DEFAULT_FIXTURE = "demo-fail";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Work out where the bundle lives from the page URL. Control serves the page at /e/<id>. */
export function resolveSource(pathname: string, search: string): EvidenceSource {
  const q = new URLSearchParams(search);
  const fx = q.get("fixture");
  if (fx !== null) {
    const name = fx === "" || fx === "1" ? DEFAULT_FIXTURE : fx;
    if (!SAFE_ID.test(name)) return { id: null, jsonUrl: null, baseUrl: null, fixture: true };
    const baseUrl = `/fixtures/evidence/${name}/`;
    return { id: name, jsonUrl: `${baseUrl}evidence.json`, baseUrl, fixture: true };
  }
  const m = pathname.match(/^\/e\/([^/]+)\/?$/);
  let id: string | null;
  try {
    id = m ? decodeURIComponent(m[1]) : q.get("id");
  } catch {
    id = null; // malformed %-escape in the path
  }
  if (!id || !SAFE_ID.test(id)) return { id: null, jsonUrl: null, baseUrl: null, fixture: false };
  const baseUrl = `/e/${encodeURIComponent(id)}/`;
  return { id, jsonUrl: `${baseUrl}evidence.json`, baseUrl, fixture: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Light shape check: enough to render without crashing, and a clear message when it is not a bundle. */
export function parseBundle(raw: unknown): EvidenceBundle {
  if (!isObj(raw)) throw new Error("evidence.json is not an object");
  const missing = ["evidence_id", "rig_id", "device", "results"].filter((k) => raw[k] === undefined);
  if (missing.length) throw new Error(`evidence.json is missing ${missing.join(", ")}`);
  if (!Array.isArray(raw.results)) throw new Error("evidence.json results is not a list");
  const results = raw.results.filter(isObj).map((r) => ({
    ...r,
    type: String(r.type ?? "unknown"),
    passed: r.passed === true,
    self_reported: r.self_reported === true,
  })) as AssertionResult[];
  const rig = isObj(raw.rig) ? raw.rig : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  return {
    evidence_id: str(raw.evidence_id),
    rig_id: str(raw.rig_id),
    device: str(raw.device),
    holder: str(raw.holder),
    farm_id: str(raw.farm_id),
    repo_url: str(raw.repo_url),
    sha: str(raw.sha),
    run_id: str(raw.run_id),
    verify_id: str(raw.verify_id),
    started_at: num(raw.started_at),
    finished_at: num(raw.finished_at),
    results,
    rig: { temp_c: num(rig.temp_c), throttled: rig.throttled === true },
    verifier_version: str(raw.verifier_version),
    frames: Array.isArray(raw.frames)
      ? raw.frames.filter(isObj).filter((f) => typeof f.file === "string" && SAFE_FILE.test(f.file as string)) as unknown as EvidenceFrame[]
      : undefined,
    sample: raw.sample === true,
  };
}

const SAFE_FILE = /^[A-Za-z0-9_.-]+$/;

/** Frames to show: the bundle's list when present, otherwise the C7 naming convention. */
export function frameCandidates(b: EvidenceBundle, probe = 6): EvidenceFrame[] {
  if (b.frames && b.frames.length) return b.frames;
  const listed = (b.files ?? []).filter((f) => /^frame-.*\.(jpe?g|png|svg)$/i.test(f)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  if (listed.length) return listed.map((file) => ({ file }));
  return Array.from({ length: probe }, (_, i) => ({ file: `frame-${i}.jpg` })).concat({ file: `frame-${probe}.jpg` });
}

// ---------- verdicts ----------

/** Per-result verdict. "unseen" = a camera check that has no measured value (device not visible). */
export type ResultKind = "confirmed" | "contradicted" | "unseen" | "self_pass" | "self_fail";

export function hasMeasured(r: AssertionResult): boolean {
  const m = r.measured;
  if (m === undefined || m === null) return false;
  if (isObj(m)) return Object.keys(m).length > 0;
  return true;
}

export function classifyResult(r: AssertionResult): ResultKind {
  if (r.self_reported) return r.passed ? "self_pass" : "self_fail";
  if (!hasMeasured(r)) return "unseen"; // C6: no pass without a measured value, even if passed=true
  return r.passed ? "confirmed" : "contradicted";
}

/** Page verdict. Green only when every check was camera-measured and passed. */
export type VerdictKind = "confirmed" | "contradicted" | "unverified" | "self_reported" | "self_failed" | "empty";
export type Tone = "ok" | "bad" | "warn";

export interface Verdict {
  kind: VerdictKind;
  tone: Tone;
  title: string;
  summary: string;
  /** True only for a camera-confirmed pass. */
  passed: boolean;
}

export function describeTarget(r: AssertionResult): string {
  return r.target ? `${r.type} on ${r.target}` : r.type;
}

export function classifyVerdict(results: AssertionResult[]): Verdict {
  if (results.length === 0)
    return { kind: "empty", tone: "warn", passed: false, title: "No checks in this bundle", summary: "The bundle has no assertion results, so nothing was verified." };
  const kinds = results.map(classifyResult);
  const camera = kinds.filter((k) => k === "confirmed" || k === "contradicted" || k === "unseen").length;
  const first = (k: ResultKind) => results[kinds.indexOf(k)];
  const why = (r: AssertionResult) => `${describeTarget(r)}: ${r.detail ?? (r.passed ? "passed" : "failed")}`;

  if (kinds.includes("contradicted")) {
    const n = kinds.filter((k) => k === "contradicted").length;
    return {
      kind: "contradicted",
      tone: "bad",
      passed: false,
      title: "Camera contradicts the claim",
      summary: `${why(first("contradicted"))}${n > 1 ? ` (and ${n - 1} more failed ${n - 1 === 1 ? "check" : "checks"})` : ""}`,
    };
  }
  if (kinds.includes("unseen")) {
    return {
      kind: "unverified",
      tone: "warn",
      passed: false,
      title: "Not verified: the camera could not measure the device",
      summary: why(first("unseen")),
    };
  }
  if (kinds.includes("self_fail")) {
    return {
      kind: "self_failed",
      tone: "warn",
      passed: false,
      title: "A self-reported check failed",
      summary: `${why(first("self_fail"))}. This check comes from the run's own logs, not the camera.`,
    };
  }
  if (camera === 0) {
    return {
      kind: "self_reported",
      tone: "warn",
      passed: false,
      title: "Self-reported only, not camera-verified",
      summary: "Every check here was read from the run's own logs. The Farm camera did not observe the device.",
    };
  }
  const self = kinds.length - camera;
  return {
    kind: "confirmed",
    tone: "ok",
    passed: true,
    title: "Confirmed by the Farm camera",
    summary: `${camera} camera ${camera === 1 ? "check" : "checks"} measured the device and matched the claim${
      self ? `; ${self} self-reported ${self === 1 ? "check" : "checks"} also passed (not camera-verified)` : ""
    }.`,
  };
}

/** Text for OpenGraph tags, so control can produce the same wording server-side. */
export function ogText(b: EvidenceBundle): { title: string; description: string } {
  const v = classifyVerdict(b.results);
  const types = [...new Set(b.results.map((r) => r.type))].join(", ") || "no checks";
  return {
    title: `${b.device} · ${types} · ${v.title}`,
    description: `${v.summary} Rig ${b.rig_id}, commit ${shortSha(b.sha) || "unknown"}.`,
  };
}

// ---------- formatting ----------

export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "";
}

/** GitHub commit URL, or null for any other host (we only link what we know the shape of). */
export function commitUrl(repoUrl: string, sha: string): string | null {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const m = repoUrl.trim().match(/^(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null;
}

/** Repo URL shown as owner/name when it is a GitHub URL; otherwise as given. */
export function repoLabel(repoUrl: string): string {
  const m = repoUrl.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : repoUrl;
}

export function safeHttpUrl(u: string): string | null {
  return /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

const toMs = (t: number) => (t > 1e12 ? t : t * 1000); // contract times are Unix seconds; tolerate ms

/** "2025-10-24 10:05:12.4 UTC". */
export function formatTimestamp(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  const iso = new Date(toMs(t)).toISOString(); // 2025-10-24T10:05:12.400Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 21)} UTC`;
}

export function formatDuration(start: number, end: number): string {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start <= 0) return "unknown";
  const s = (toMs(end) - toMs(start)) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Unit for a quantity key from C6. */
export function unitOf(key: string): string {
  if (key === "ms" || key.endsWith("_ms")) return "ms";
  if (key === "hz" || key.endsWith("_hz")) return "Hz";
  if (key === "duty" || key === "pct" || key.endsWith("_pct")) return "%";
  if (key.endsWith("_s") && !key.endsWith("_per_s")) return "s";
  if (key.endsWith("cols_per_s")) return "cols/s";
  if (key === "cells" || key.endsWith("_cells")) return "cells";
  if (key === "temp_c" || key.endsWith("_c")) return "°C";
  return "";
}

const DECIMALS: Record<string, number> = { ms: 0, Hz: 2, "%": 0, s: 1, "cols/s": 1, cells: 0, "°C": 1 };

/** Number with unit and fixed decimals. Duty is a 0–1 fraction in C6 and shown as a percentage. */
export function formatQuantity(key: string, value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return formatPlain(value);
  const unit = unitOf(key);
  const v = key === "duty" ? value * 100 : value;
  const d = DECIMALS[unit] ?? (Number.isInteger(v) ? 0 : 2);
  return unit ? `${v.toFixed(d)} ${unit}` : v.toFixed(d);
}

export function formatPlain(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return `[${v.join(", ")}]`;
  return JSON.stringify(v);
}

/** "± 33 ms" for a key, from C6 uncertainty (keyed either by the quantity or by its unit key). */
export function uncertaintyFor(key: string, u: Record<string, number> | undefined): string | null {
  if (!u) return null;
  const direct = u[key];
  const byUnit = unitOf(key) === "ms" ? u.ms : undefined;
  const val = direct ?? byUnit;
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  return `± ${formatQuantity(key, val)}`;
}

// ---------- expected vs measured ----------

export interface QuantityRow {
  key: string;
  label: string;
  expected: string;
  measured: string;
  pm: string | null;
}

const LABELS: Record<string, string> = {
  hz: "Frequency",
  duty: "Duty cycle",
  state: "State",
  color: "Colour",
  text: "Text",
  scroll_cols_per_s: "Scroll speed",
  pattern: "Log pattern",
  line: "Matching log line",
  hold_s: "Hold time",
  repeat: "Repeats",
  cycles: "Cycles observed",
};

export function labelOf(key: string): string {
  return LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Keys rendered elsewhere: sequences, matrices, and tolerances (shown as the tolerance line). */
const SPECIAL = new Set(["steps", "ascii"]);
export const isTolerance = (k: string) => k.startsWith("tol_");

/** Generic key-by-key rows for scalar quantities, in expected order then measured-only keys. */
export function quantityRows(r: AssertionResult): QuantityRow[] {
  const exp = isObj(r.expected) ? r.expected : {};
  const mea = isObj(r.measured) ? r.measured : {};
  if (r.type === "log_contains" && ("pattern" in exp || "line" in mea)) {
    // Pattern vs the log line that matched it: one row, not two half-empty ones.
    return [{ key: "line", label: "Log line", expected: formatPlain(exp.pattern), measured: "line" in mea ? formatPlain(mea.line) : "not found", pm: null }];
  }
  const keys = [...new Set([...Object.keys(exp), ...Object.keys(mea)])].filter((k) => !SPECIAL.has(k) && !isTolerance(k));
  return keys.map((k) => ({
    key: k,
    label: labelOf(k),
    expected: k in exp ? formatQuantity(k, exp[k]) : "—",
    measured: k in mea ? formatQuantity(k, mea[k]) : "not measured",
    pm: k in mea ? uncertaintyFor(k, r.uncertainty) : null,
  }));
}

/** Tolerances from the expected spec, e.g. "± 80 ms per step". */
export function toleranceText(r: AssertionResult): string | null {
  const exp = isObj(r.expected) ? r.expected : {};
  const parts = Object.entries(exp)
    .filter(([k, v]) => isTolerance(k) && typeof v === "number")
    .map(([k, v]) => {
      const unitKey = k.slice(4); // tol_ms -> ms
      const per = r.type === "led_sequence" && unitKey === "ms" ? " per step" : "";
      return `± ${formatQuantity(unitKey, v as number)}${per}`;
    });
  return parts.length ? parts.join(", ") : null;
}

export interface SeqStep {
  on: number[];
  ms: number;
}
export interface StepRow {
  index: number; // 1-based
  expected: SeqStep | null;
  measured: SeqStep | null;
  ledsMatch: boolean;
  timeMatch: boolean;
}

function asSteps(v: unknown): SeqStep[] | null {
  if (!isObj(v) || !Array.isArray(v.steps)) return null;
  return v.steps.filter(isObj).map((s) => ({
    on: Array.isArray(s.on) ? (s.on.filter((x) => typeof x === "number") as number[]) : [],
    ms: typeof s.ms === "number" ? s.ms : NaN,
  }));
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Step-by-step comparison for led_sequence. Null if either side has no steps. */
export function sequenceRows(r: AssertionResult): StepRow[] | null {
  const exp = asSteps(r.expected);
  const mea = asSteps(r.measured);
  if (!exp && !mea) return null;
  const tol = isObj(r.expected) && typeof r.expected.tol_ms === "number" ? r.expected.tol_ms : 0;
  const n = Math.max(exp?.length ?? 0, mea?.length ?? 0);
  return Array.from({ length: n }, (_, i) => {
    const e = exp?.[i] ?? null;
    const m = mea?.[i] ?? null;
    return {
      index: i + 1,
      expected: e,
      measured: m,
      ledsMatch: !!e && !!m && sameSet(e.on, m.on),
      timeMatch: !!e && !!m && Number.isFinite(m.ms) && Math.abs(m.ms - e.ms) <= tol,
    };
  });
}

/** How many LEDs to draw for a bank: at least 5 (onboard + GP16–GP19), more if a step names a higher index. */
export function bankSize(rows: StepRow[]): number {
  const max = Math.max(4, ...rows.flatMap((r) => [...(r.expected?.on ?? []), ...(r.measured?.on ?? [])]));
  return Math.min(max + 1, 16);
}

/** Matrix grids (matrix_frame) as rows of strings, if present. */
export function matrixOf(v: unknown): string[] | null {
  if (!isObj(v) || !Array.isArray(v.ascii)) return null;
  return v.ascii.filter((x): x is string => typeof x === "string");
}
