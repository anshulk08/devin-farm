// Pure formatting helpers for the drawers, modal, command bar and toasts. No React here so it stays testable.
import type { AssertionResult, SourceMode } from "../../state/types";
import type { VerdictTone } from "../../state/reducer";

/** Trim a number to at most `digits` decimals without trailing zeros. */
export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(digits)));
}

interface UnitRule {
  re: RegExp;
  unit: string;
  scale?: number;
}

// Order matters: the first rule whose pattern matches the key wins. The matched suffix is stripped from the label.
const UNIT_RULES: UnitRule[] = [
  { re: /(^|_)cols_per_s$/, unit: "col/s" },
  { re: /(^|_)ms$/, unit: "ms" },
  { re: /(^|_)hz$/, unit: "Hz" },
  { re: /(^|_)pct$/, unit: "%" },
  { re: /^duty$/, unit: "%", scale: 100 },
  { re: /(^|_)cells$/, unit: "cells" },
  { re: /(^|_)s$/, unit: "s" },
  { re: /(^|_)c$/, unit: "°C" },
  { re: /(^|_)mb$/, unit: "MB" },
];

/** Unit, scale and remaining label for a measurement key like `tol_ms` → {label: "tol", unit: "ms"}. */
export function unitFor(key: string): { label: string; unit: string; scale: number } {
  for (const r of UNIT_RULES) {
    if (r.re.test(key)) {
      const label = key === "duty" ? "duty" : key.replace(r.re, "");
      return { label: label.replace(/_/g, " "), unit: r.unit, scale: r.scale ?? 1 };
    }
  }
  return { label: key.replace(/_/g, " "), unit: "", scale: 1 };
}

function withUnit(n: number, unit: string): string {
  return unit ? `${fmtNum(n)} ${unit}` : fmtNum(n);
}

function field(key: string, v: unknown): string {
  const { label, unit, scale } = unitFor(key);
  let value: string;
  if (typeof v === "number") value = withUnit(v * scale, unit);
  else if (Array.isArray(v) && v.every((x) => typeof x === "number")) value = (v as number[]).map((x) => fmtNum(x)).join(", ");
  else value = formatValue(v, true);
  return label ? `${label} ${value}` : value;
}

/**
 * Human-readable rendering of a C6 `measured` / `expected` value.
 * Numbers get units from their key; `steps` become one numbered line each; ASCII matrices stay as rows.
 * `inline` joins object fields with " · " instead of newlines.
 */
export function formatValue(v: unknown, inline = false): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    if (v.length === 0) return "none";
    if (v.every((x) => typeof x === "string")) return (v as string[]).join("\n");
    if (v.every((x) => typeof x === "number")) return (v as number[]).map((x) => fmtNum(x)).join(", ");
    return v.map((x) => formatValue(x, true)).join(inline ? " · " : "\n");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "—";
    const parts = entries.map(([k, x]) => {
      if (k === "steps" && Array.isArray(x)) return x.map((st, i) => `${i + 1}. ${formatValue(st, true)}`).join("\n");
      return field(k, x);
    });
    return parts.join(inline ? " · " : "\n");
  }
  return String(v);
}

/** `{ms: 33}` → "± 33 ms". Several keys are joined with ", ". Missing → "—". */
export function formatUncertainty(u?: Record<string, number>): string {
  if (!u) return "—";
  const entries = Object.entries(u);
  if (entries.length === 0) return "—";
  return entries
    .map(([k, n]) => {
      const { unit, scale } = unitFor(k);
      return `± ${withUnit(n * scale, unit || k)}`;
    })
    .join(", ");
}

/** Chip tone for one result. Self-reported is amber whatever it says: it can never be green. */
export function resultTone(r: AssertionResult): VerdictTone {
  if (r.self_reported) return "self";
  return r.passed ? "pass" : "fail";
}

export function resultLabel(r: AssertionResult): string {
  if (r.self_reported) return r.passed ? "Self-reported" : "Self-reported, failed";
  return r.passed ? "Confirmed" : "Contradicted";
}

export const VERDICT_LABEL: Record<VerdictTone, string> = {
  pass: "Confirmed by camera",
  fail: "Contradicted by camera",
  self: "Self-reported only",
};

/** Local wall-clock time "14:03:27" from Unix seconds. */
export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
}

/** Why a mutating control is disabled, or null when it may hit the network. */
export function gateReason(mode: SourceMode, scrubTs: number | null): string | null {
  if (mode === "mock") return "Not available in mock data";
  if (mode === "replay") return "Not available in replay";
  if (scrubTs != null) return "Not available while viewing the past. Return the timeline to now first";
  return null;
}

/**
 * Subsequence fuzzy match. Returns null when `q` is not a subsequence of `text`, else a score
 * (higher is better) that rewards consecutive runs and word starts and penalises gaps.
 */
export function fuzzyScore(q: string, text: string): number | null {
  const query = q.trim().toLowerCase();
  if (!query) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of query) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    score += 1;
    if (at === prev + 1) score += 5;
    if (at === 0 || /[\s:/\-_.]/.test(t[at - 1])) score += 8;
    score -= Math.min(at - ti, 10) * 0.2;
    prev = at;
    ti = at + 1;
  }
  // A literal substring beats any scattered match, more so at a word start.
  const sub = t.indexOf(query);
  if (sub >= 0) score += query.length * 6 + (sub === 0 || /[\s:/\-_.]/.test(t[sub - 1]) ? 10 : 0);
  return score - t.length * 0.01;
}

/** SVG path for a sparkline in a w×h box with `pad` px inset. Flat series draw a centred line. */
export function sparkPath(values: number[], w: number, h: number, pad = 2): { d: string; min: number; max: number } {
  if (values.length === 0) return { d: "", min: 0, max: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pts = values.length === 1 ? [values[0], values[0]] : values;
  const step = (w - pad * 2) / (pts.length - 1);
  const y = (v: number) => (span === 0 ? h / 2 : pad + (h - pad * 2) * (1 - (v - min) / span));
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${fmtNum(pad + i * step, 1)},${fmtNum(y(v), 1)}`).join(" ");
  return { d, min, max };
}

export const rigName = (rigNodeId: string) => rigNodeId.replace(/^rig:/, "");
export const farmIdOf = (sessionNodeId: string) => sessionNodeId.replace(/^session:/, "");
export const leaseIdOf = (edgeId: string) => edgeId.replace(/^(lease|queue):/, "");
