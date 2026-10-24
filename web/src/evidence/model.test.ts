import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AssertionResult } from "../state/types";
import {
  classifyResult,
  classifyVerdict,
  commitUrl,
  formatDuration,
  formatQuantity,
  formatTimestamp,
  frameCandidates,
  ogText,
  parseBundle,
  quantityRows,
  repoLabel,
  resolveSource,
  sequenceRows,
  shortSha,
  toleranceText,
  uncertaintyFor,
} from "./model";

const fixture = (name: string) =>
  parseBundle(JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/fixtures/evidence/${name}/evidence.json`, import.meta.url)), "utf8")));

const seqFail: AssertionResult = {
  type: "led_sequence",
  target: "pico.leds",
  passed: false,
  expected: { steps: [{ on: [0, 2], ms: 500 }, { on: [1], ms: 500 }], repeat: 3, tol_ms: 80 },
  measured: { steps: [{ on: [0, 2], ms: 498 }, { on: [0, 1], ms: 503 }] },
  uncertainty: { ms: 33 },
  detail: "step 2: LED 0 still on (expected only LED 1)",
  self_reported: false,
};
const logPass: AssertionResult = { type: "log_contains", passed: true, expected: { pattern: "READY" }, measured: { line: "READY" }, self_reported: true };
const unseen: AssertionResult = { type: "led_blink", target: "pico.led", passed: false, detail: "device not visible: uncalibrated", self_reported: false };

describe("verdict classification", () => {
  it("red when the camera contradicts, with the failing detail", () => {
    const v = classifyVerdict([seqFail, logPass]);
    expect(v.kind).toBe("contradicted");
    expect(v.tone).toBe("bad");
    expect(v.title).toBe("Camera contradicts the claim");
    expect(v.summary).toContain("step 2: LED 0 still on");
  });

  it("green only when every camera check is measured and passed", () => {
    const ok = { ...seqFail, passed: true, detail: undefined };
    const v = classifyVerdict([ok, logPass]);
    expect(v.kind).toBe("confirmed");
    expect(v.passed).toBe(true);
    expect(v.title).toBe("Confirmed by the Farm camera");
    expect(v.summary).toContain("not camera-verified");
  });

  it("amber, never green, for self-reported only", () => {
    const v = classifyVerdict([logPass]);
    expect(v.kind).toBe("self_reported");
    expect(v.tone).toBe("warn");
    expect(v.title).toBe("Self-reported only, not camera-verified");
    expect(v.passed).toBe(false);
  });

  it("a passed camera result with no measured value is not a pass", () => {
    const bogus: AssertionResult = { type: "led_state", passed: true, self_reported: false };
    expect(classifyResult(bogus)).toBe("unseen");
    expect(classifyVerdict([bogus]).kind).toBe("unverified");
    expect(classifyVerdict([unseen]).tone).toBe("warn");
  });

  it("contradiction outranks not-visible and self-reported failures", () => {
    const selfFail = { ...logPass, passed: false };
    expect(classifyVerdict([unseen, selfFail, seqFail]).kind).toBe("contradicted");
    expect(classifyVerdict([{ ...seqFail, passed: true }, selfFail]).kind).toBe("self_failed");
  });

  it("empty results are not a pass", () => {
    expect(classifyVerdict([]).kind).toBe("empty");
  });
});

describe("source resolution", () => {
  it("reads the id from /e/<id>", () => {
    expect(resolveSource("/e/abc123", "")).toMatchObject({ id: "abc123", jsonUrl: "/e/abc123/evidence.json", baseUrl: "/e/abc123/", fixture: false });
  });
  it("falls back to ?id=", () => {
    expect(resolveSource("/evidence.html", "?id=x_9").jsonUrl).toBe("/e/x_9/evidence.json");
    expect(resolveSource("/e/%E0%A4%A", "").id).toBeNull(); // malformed escape must not throw
  });
  it("loads fixtures", () => {
    expect(resolveSource("/evidence.html", "?fixture=1").baseUrl).toBe("/fixtures/evidence/demo-fail/");
    expect(resolveSource("/", "?fixture=demo-pass").jsonUrl).toBe("/fixtures/evidence/demo-pass/evidence.json");
  });
  it("rejects missing or unsafe ids", () => {
    expect(resolveSource("/evidence.html", "").id).toBeNull();
    expect(resolveSource("/evidence.html", "?id=../../etc").id).toBeNull();
    expect(resolveSource("/", "?fixture=../x").jsonUrl).toBeNull();
  });
});

describe("formatting", () => {
  it("formats quantities with units", () => {
    expect(formatQuantity("ms", 503)).toBe("503 ms");
    expect(formatQuantity("hz", 2)).toBe("2.00 Hz");
    expect(formatQuantity("duty", 0.3)).toBe("30 %");
    expect(formatQuantity("scroll_cols_per_s", 10)).toBe("10.0 cols/s");
    expect(formatQuantity("state", "on")).toBe("on");
  });
  it("formats uncertainty with ±", () => {
    expect(uncertaintyFor("ms", { ms: 33 })).toBe("± 33 ms");
    expect(uncertaintyFor("hz", { hz: 0.05 })).toBe("± 0.05 Hz");
    expect(uncertaintyFor("state", { ms: 33 })).toBeNull();
    expect(toleranceText(seqFail)).toBe("± 80 ms per step");
  });
  it("formats times in UTC with tenths", () => {
    expect(formatTimestamp(1_761_300_312.4)).toBe("2025-10-24 10:05:12.4 UTC");
    expect(formatTimestamp(0)).toBe("unknown");
    expect(formatDuration(100, 104.25)).toBe("4.3 s");
    expect(formatDuration(100, 190)).toBe("1 min 30 s");
  });
  it("links GitHub commits only", () => {
    expect(shortSha("4f1c2e9a7b")).toBe("4f1c2e9");
    expect(commitUrl("https://github.com/anshulk08/farm-tickets", "4f1c2e9a7b")).toBe("https://github.com/anshulk08/farm-tickets/commit/4f1c2e9a7b");
    expect(commitUrl("git@github.com:a/b.git", "abcdef1")).toBe("https://github.com/a/b/commit/abcdef1");
    expect(commitUrl("https://gitlab.com/a/b", "abcdef1")).toBeNull();
    expect(commitUrl("https://github.com/a/b", "not-a-sha")).toBeNull();
    expect(repoLabel("https://github.com/a/b.git")).toBe("a/b");
  });
});

describe("expected vs measured", () => {
  it("compares led_sequence step by step", () => {
    const rows = sequenceRows(seqFail)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ledsMatch: true, timeMatch: true });
    expect(rows[1]).toMatchObject({ ledsMatch: false, timeMatch: true });
  });
  it("builds scalar rows with ± and skips tolerances", () => {
    const blink: AssertionResult = {
      type: "led_blink",
      passed: true,
      expected: { hz: 2, duty: 0.3, tol_pct: 10 },
      measured: { hz: 1.98, duty: 0.31 },
      uncertainty: { hz: 0.05, duty: 0.02 },
      self_reported: false,
    };
    expect(quantityRows(blink)).toEqual([
      { key: "hz", label: "Frequency", expected: "2.00 Hz", measured: "1.98 Hz", pm: "± 0.05 Hz" },
      { key: "duty", label: "Duty cycle", expected: "30 %", measured: "31 %", pm: "± 2 %" },
    ]);
    expect(quantityRows(seqFail).map((r) => r.key)).toEqual(["repeat"]);
    expect(quantityRows(logPass)).toEqual([{ key: "line", label: "Log line", expected: "READY", measured: "READY", pm: null }]);
  });
});

describe("fixtures", () => {
  it("demo-fail is a camera contradiction on pico-1", () => {
    const b = fixture("demo-fail");
    expect(b.sample).toBe(true);
    expect(b.device).toBe("pico-1");
    expect(b.holder).toBe("devin-s-1a2b3c4d");
    expect(classifyVerdict(b.results).kind).toBe("contradicted");
    expect(frameCandidates(b).length).toBeGreaterThan(0);
    expect(ogText(b).title).toContain("Camera contradicts the claim");
  });
  it("demo-pass is camera-confirmed", () => {
    const b = fixture("demo-pass");
    expect(classifyVerdict(b.results).kind).toBe("confirmed");
  });
  it("rejects things that are not bundles", () => {
    expect(() => parseBundle([])).toThrow();
    expect(() => parseBundle({ evidence_id: "x" })).toThrow(/missing/);
  });
});
