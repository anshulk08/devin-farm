// STUB (lane-d/data owns this): plays an ndjson recording/fixture with real timing.
import type { FeedSource } from "./source";
import { sampleGraph, T0 } from "./sampleGraph";

export interface PlayerOptions {
  loop?: boolean;
  speed?: number;
}

export function createPlayer(_url: string, _opts: PlayerOptions = {}): FeedSource {
  return ({ onEvent, onConnection, onReset }) => {
    onConnection("open");
    onReset();
    onEvent({ name: "graph_snapshot", data: { ...sampleGraph, ts: T0 } });
    return () => {};
  };
}
