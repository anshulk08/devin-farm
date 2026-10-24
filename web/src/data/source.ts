// Where events come from. Every source feeds the same reducer (FRONTEND §1, §8).
import type { FarmEvent, FarmEventName, SourceMode } from "../state/types";
import type { Connection } from "../state/reducer";
import { api } from "./api";
import { createPlayer } from "./player";

export interface FeedHandlers {
  onEvent: (ev: FarmEvent) => void;
  onConnection: (c: Connection) => void;
  /** Called before a fresh snapshot replaces the graph (reconnect, replay restart). */
  onReset: () => void;
}

/** Start the feed; returns a stop function. */
export type FeedSource = (h: FeedHandlers) => () => void;

export interface ModeInfo {
  mode: SourceMode;
  /** For replay: the recording URL. For mock: the fixture URL. */
  url?: string;
}

export function modeFromLocation(search = window.location.search): ModeInfo {
  const q = new URLSearchParams(search);
  if (q.get("replay")) {
    const f = q.get("replay")!;
    return { mode: "replay", url: f.includes("/") || f.endsWith(".ndjson") ? f : `/fixtures/${f}.ndjson` };
  }
  if (q.get("mock") === "1" || import.meta.env.VITE_MOCK === "1") return { mode: "mock", url: q.get("fixture") ?? "/fixtures/demo.ndjson" };
  return { mode: "live" };
}

const EVENT_NAMES: FarmEventName[] = [
  "graph_snapshot",
  "rig_health",
  "device",
  "lease",
  "run",
  "log",
  "verify",
  "evidence",
  "session",
  "session_message",
];

/** Live: snapshot from /api/graph, then SSE. On loss keep the last graph (banner greys it), resnapshot on reopen. */
export const liveSource: FeedSource = ({ onEvent, onConnection, onReset }) => {
  let closed = false;
  let es: EventSource | null = null;

  const snapshot = async () => {
    try {
      const g = await api.graph();
      if (closed) return;
      onReset();
      onEvent({ name: "graph_snapshot", data: { ...g, ts: Date.now() / 1000 } });
    } catch {
      /* SSE graph_snapshot on connect covers this too */
    }
  };

  const open = () => {
    es = new EventSource(api.eventsUrl);
    es.onopen = () => {
      onConnection("open");
      void snapshot();
    };
    es.onerror = () => onConnection("lost"); // EventSource retries on its own
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (m) => {
        try {
          const data = JSON.parse((m as MessageEvent<string>).data);
          if (name === "graph_snapshot") onReset();
          onEvent({ name, data } as FarmEvent);
        } catch (err) {
          console.warn("[farm] bad event", name, err);
        }
      });
    }
  };

  onConnection("connecting");
  open();
  return () => {
    closed = true;
    es?.close();
  };
};

export function sourceFor(info: ModeInfo): FeedSource {
  if (info.mode === "live") return liveSource;
  return createPlayer(info.url!, { loop: info.mode === "mock" });
}
