import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer, parseNdjson, playback, shiftEvent } from "./player";
import type { FarmEvent } from "../state/types";
import type { Connection } from "../state/reducer";

const T = 1_000;
const evs: FarmEvent[] = [
  { name: "graph_snapshot", data: { nodes: [], edges: [{ id: "lease:L", kind: "lease", source: "a", target: "b", data: { token: 1, expires_at: T + 300 } }], ts: T } },
  { name: "session_message", data: { farm_id: "s-1", source: "user", text: "one", ts: T + 1 } },
  { name: "session_message", data: { farm_id: "s-1", source: "devin", text: "two", ts: T + 1 } },
  { name: "lease", data: { rig_id: "r", device: "d", lease_id: "L", holder: "devin-s-1", event: "renewed", expires_at: T + 400, ts: T + 4 } },
];
const body = evs.map((e) => JSON.stringify(e)).join("\n") + "\n\n";

function harness() {
  const log: string[] = [];
  const got: FarmEvent[] = [];
  const h = {
    onEvent: (e: FarmEvent) => {
      got.push(e);
      log.push(`ev:${e.name}`);
    },
    onConnection: (c: Connection) => log.push(`conn:${c}`),
    onReset: () => log.push("reset"),
  };
  return { h, log, got };
}

const flush = async () => {
  // let the fetch/text promises resolve under fake timers
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(50_000_000);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseNdjson / shiftEvent", () => {
  it("skips blank and bad lines", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseNdjson(`${body}not json\n{"name":"x"}\n`)).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("shifts ts and expiry everywhere, without mutating", () => {
    const s = shiftEvent(evs[0], 10) as Extract<FarmEvent, { name: "graph_snapshot" }>;
    expect(s.data.ts).toBe(T + 10);
    expect(s.data.edges[0].data?.expires_at).toBe(T + 310);
    expect((evs[0] as typeof s).data.edges[0].data?.expires_at).toBe(T + 300);
    const l = shiftEvent(evs[3], 10) as Extract<FarmEvent, { name: "lease" }>;
    expect([l.data.ts, l.data.expires_at]).toEqual([T + 14, T + 410]);
  });
});

describe("createPlayer", () => {
  it("opens, resets, then plays with real relative timing (replay keeps timestamps)", async () => {
    const { h, log, got } = harness();
    const stop = createPlayer("/x.ndjson", { speed: 1 })(h);
    await flush();
    expect(log).toEqual(["conn:connecting", "conn:open", "reset", "ev:graph_snapshot"]);
    vi.advanceTimersByTime(999);
    expect(got).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(got.map((e) => e.data.ts)).toEqual([T, T + 1, T + 1]);
    vi.advanceTimersByTime(3000);
    expect(got).toHaveLength(4);
    expect(playback.getSnapshot()).toMatchObject({ active: true, playing: false, position: 4, duration: 4 });
    stop();
    expect(playback.getSnapshot().active).toBe(false);
  });

  it("scales timing by speed", async () => {
    const { h, got } = harness();
    const stop = createPlayer("/x.ndjson", { speed: 4 })(h);
    await flush();
    vi.advanceTimersByTime(1000);
    expect(got).toHaveLength(4);
    stop();
  });

  it("loops in mock mode: reset, snapshot again, timestamps keep increasing", async () => {
    const { h, log, got } = harness();
    const stop = createPlayer("/x.ndjson", { loop: true })(h);
    await flush();
    vi.advanceTimersByTime(4000 + 3000);
    expect(log.filter((l) => l === "reset")).toHaveLength(2);
    expect(got[4].name).toBe("graph_snapshot");
    // rebased onto the wall clock
    expect(got[0].data.ts).toBe(50_000);
    for (let i = 1; i < got.length; i++) expect(got[i].data.ts).toBeGreaterThanOrEqual(got[i - 1].data.ts);
    stop();
  });

  it("loops without going backwards at high speed", async () => {
    const { h, got } = harness();
    const stop = createPlayer("/x.ndjson", { loop: true, speed: 8 })(h);
    await flush();
    vi.advanceTimersByTime(3000);
    expect(got.length).toBeGreaterThan(5);
    for (let i = 1; i < got.length; i++) expect(got[i].data.ts).toBeGreaterThanOrEqual(got[i - 1].data.ts);
    stop();
  });

  it("counts a loop pass once even if paused or re-sped during the end-of-pass gap", async () => {
    const { h } = harness();
    const stop = createPlayer("/x.ndjson", { loop: true })(h);
    await flush();
    vi.advanceTimersByTime(4000 + 1000); // inside the 3 s gap
    playback.pause();
    playback.resume();
    playback.setSpeed(2);
    expect(playback.getSnapshot().pass).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(playback.getSnapshot().pass).toBe(1);
    stop();
  });

  it("pause holds events, resume continues; seek fast-forwards after a reset", async () => {
    const { h, log, got } = harness();
    const stop = createPlayer("/x.ndjson", {})(h);
    await flush();
    playback.pause();
    expect(playback.getSnapshot().playing).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(got).toHaveLength(1);
    playback.resume();
    vi.advanceTimersByTime(1000);
    expect(got).toHaveLength(3);

    playback.seek(2);
    expect(log.filter((l) => l === "reset")).toHaveLength(2);
    expect(got.slice(3).map((e) => e.name)).toEqual(["graph_snapshot", "session_message", "session_message"]);
    vi.advanceTimersByTime(2000);
    expect(got.at(-1)!.name).toBe("lease");
    stop();
  });

  it("reports a lost connection when the file cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { h, log } = harness();
    createPlayer("/missing.ndjson")(h);
    await flush();
    expect(log).toEqual(["conn:connecting", "conn:lost"]);
    warn.mockRestore();
  });
});
