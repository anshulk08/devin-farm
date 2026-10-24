// Single store: useReducer fed by the active source. Keeps the raw event log for the timeline scrubber.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { foldEvents, initialState, reducer, type Action, type FarmState } from "./reducer";
import type { FarmEvent } from "./types";
import { modeFromLocation, sourceFor, type ModeInfo } from "../data/source";

export const LOG_WINDOW_S = 30 * 60;

export interface Store {
  /** What the screen shows: live state, or the folded state at `scrubTs`. */
  state: FarmState;
  live: FarmState;
  dispatch: (a: Action) => void;
  mode: ModeInfo;
  /** Buffered events (last 30 min), oldest first. `logVersion` changes when it grows. */
  log: FarmEvent[];
  logVersion: number;
  scrubTs: number | null;
  setScrubTs: (ts: number | null) => void;
}

const Ctx = createContext<Store | null>(null);

export function FarmProvider({ children, mode: modeOverride }: { children: ReactNode; mode?: ModeInfo }) {
  const mode = useMemo(() => modeOverride ?? modeFromLocation(), [modeOverride]);
  const [live, dispatch] = useReducer(reducer, initialState);
  const logRef = useRef<FarmEvent[]>([]);
  const [logVersion, setLogVersion] = useState(0);
  const [scrubTs, setScrubTs] = useState<number | null>(null);

  useEffect(() => {
    const start = sourceFor(mode);
    return start({
      onEvent: (event) => {
        const log = logRef.current;
        log.push(event);
        const cutoff = event.data.ts - LOG_WINDOW_S;
        // Keep the newest snapshot inside the window so a scrub can always rebuild from it.
        let i = 0;
        while (i < log.length - 1 && log[i].data.ts < cutoff && log.slice(i + 1).some((e) => e.name === "graph_snapshot")) i++;
        if (i > 0) log.splice(0, i);
        dispatch({ type: "event", event });
        setLogVersion((v) => v + 1);
      },
      onConnection: (status) => dispatch({ type: "connection", status }),
      onReset: () => {
        logRef.current.length = 0;
        setLogVersion((v) => v + 1);
        dispatch({ type: "reset" });
      },
    });
  }, [mode]);

  const scrubbed = useMemo(() => {
    if (scrubTs == null) return null;
    const upto = logRef.current.filter((e) => e.data.ts <= scrubTs);
    // Start from the last snapshot at or before the scrub point.
    let start = 0;
    upto.forEach((e, i) => e.name === "graph_snapshot" && (start = i));
    return { ...foldEvents(upto.slice(start)), connection: live.connection };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubTs, logVersion]);

  const setScrub = useCallback((ts: number | null) => setScrubTs(ts), []);

  const value: Store = {
    state: scrubbed ?? live,
    live,
    dispatch,
    mode,
    log: logRef.current,
    logVersion,
    scrubTs,
    setScrubTs: setScrub,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFarm(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useFarm outside FarmProvider");
  return s;
}
