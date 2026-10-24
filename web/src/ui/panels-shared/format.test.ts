import { describe, expect, it } from "vitest";
import { formatUncertainty, formatValue, fuzzyScore, gateReason, resultLabel, resultTone, sparkPath, unitFor } from "./format";

describe("formatValue", () => {
  it("renders led_sequence steps one per line with units", () => {
    const m = { steps: [{ on: [0, 2], ms: 498 }, { on: [0, 1], ms: 503 }] };
    expect(formatValue(m)).toBe("1. on 0, 2 · 498 ms\n2. on 0, 1 · 503 ms");
  });
  it("adds units from keys and scales duty to percent", () => {
    expect(formatValue({ hz: 2.03, duty: 0.31, tol_pct: 10 })).toBe("2.03 Hz\nduty 31 %\ntol 10 %");
    expect(formatValue({ hold_s: 2, tol_cells: 2 })).toBe("hold 2 s\ntol 2 cells");
  });
  it("keeps ascii matrices as rows and handles empties", () => {
    expect(formatValue(["#..", ".#."])).toBe("#..\n.#.");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue({ state: "on" })).toBe("state on");
  });
});

describe("formatUncertainty", () => {
  it("always prefixes ± and a unit", () => {
    expect(formatUncertainty({ ms: 33 })).toBe("± 33 ms");
    expect(formatUncertainty({ pct: 4.25, cells: 1 })).toBe("± 4.25 %, ± 1 cells");
    expect(formatUncertainty({ px: 1.5 })).toBe("± 1.5 px");
    expect(formatUncertainty(undefined)).toBe("—");
  });
  it("maps keys to units", () => {
    expect(unitFor("scroll_cols_per_s")).toEqual({ label: "scroll", unit: "col/s", scale: 1 });
  });
});

describe("result tone", () => {
  it("never makes a self-reported result green", () => {
    const r = { type: "log_contains", passed: true, self_reported: true };
    expect(resultTone(r)).toBe("self");
    expect(resultLabel(r)).toBe("Self-reported");
    expect(resultTone({ ...r, self_reported: false })).toBe("pass");
    expect(resultTone({ ...r, self_reported: false, passed: false })).toBe("fail");
  });
});

describe("gateReason", () => {
  it("blocks mutations outside live", () => {
    expect(gateReason("mock", null)).toMatch(/mock data/);
    expect(gateReason("replay", null)).toMatch(/replay/);
    expect(gateReason("live", 123)).toMatch(/past/);
    expect(gateReason("live", null)).toBeNull();
  });
});

describe("fuzzyScore", () => {
  it("matches subsequences and prefers word starts", () => {
    expect(fuzzyScore("p1", "device pico-1")).not.toBeNull();
    expect(fuzzyScore("xyz", "device pico-1")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("pico", "device pico-1")!).toBeGreaterThan(fuzzyScore("pico", "session p-i-c-o")!);
  });
});

describe("sparkPath", () => {
  it("spans the box and reports the range", () => {
    const { d, min, max } = sparkPath([1, 3, 2], 100, 20, 0);
    expect(min).toBe(1);
    expect(max).toBe(3);
    expect(d).toBe("M0,20 L50,0 L100,10");
  });
  it("draws flat and single-point series as a centred line", () => {
    expect(sparkPath([5, 5], 10, 10, 0).d).toBe("M0,5 L10,5");
    expect(sparkPath([5], 10, 10, 0).d).toBe("M0,5 L10,5");
    expect(sparkPath([], 10, 10).d).toBe("");
  });
});
