// Bottom timeline scrubber (FRONTEND §5): the last 30 min of buffered events as tick marks.
// Dragging folds the store's log up to that moment (setScrubTs); "Back to live" returns to the live state.
// In mock/replay it also carries play/pause and speed for the active player.
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { useFarm, LOG_WINDOW_S } from "../state/store";
import { verdictTone } from "../state/reducer";
import { clock } from "../state/selectors";
import type { FarmEvent } from "../state/types";
import { playback, SPEEDS } from "../data/player";
import "./Timeline.css";

const MIN_SPAN_S = 60;

type TickTone = "pass" | "fail" | "self" | "warn" | "lease" | "neutral";
interface Tick {
  ts: number;
  tone: TickTone;
  major: boolean;
}

/** Which events earn a tick, and in what colour. rig_health and log lines are too dense to mark. */
function tickFor(ev: FarmEvent): Omit<Tick, "ts"> | null {
  switch (ev.name) {
    case "verify":
      if (ev.data.state === "pending") return { tone: "neutral", major: false };
      // A verify error (camera down, uncalibrated…) is degraded, not contradicted by the camera: amber, never red.
      if (ev.data.state === "error") return { tone: "warn", major: true };
      return { tone: verdictTone(ev.data.results ?? []), major: true };
    case "evidence":
      return null; // the verify tick already carries the verdict
    case "lease":
      if (ev.data.event === "expired" || ev.data.event === "revoked") return { tone: "warn", major: false };
      if (ev.data.event === "renewed") return null;
      return { tone: "lease", major: false };
    case "run":
      return ev.data.state === "failed" ? { tone: "warn", major: false } : { tone: "neutral", major: false };
    case "session":
    case "session_message":
    case "device":
    case "graph_snapshot":
      return { tone: "neutral", major: false };
    default:
      return null;
  }
}

const wallFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const wallClock = (ts: number) => wallFmt.format(new Date(ts * 1000));
const ago = (s: number) => (s < 0.5 ? "0:00" : `-${clock(s)}`);
const agoWords = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  return m > 0 ? `${m} min ${t % 60} s ago` : `${t} s ago`;
};

export function Timeline() {
  const { live, log, logVersion, scrubTs, setScrubTs, mode } = useFarm();
  // Only a live feed may say "Live" (honesty rule: mocks and replays are always labelled).
  const headWord = mode.mode === "live" ? "Live" : "Latest";
  const pb = useSyncExternalStore(playback.subscribe, playback.getSnapshot, playback.getSnapshot);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverTs, setHoverTs] = useState<number | null>(null);

  const end = live.now;
  const first = log.length ? log[0].data.ts : end;
  const start = Math.min(Math.max(end - LOG_WINDOW_S, first), end - MIN_SPAN_S);
  const span = end - start;

  const ticks = useMemo(() => {
    const out: Tick[] = [];
    for (const ev of log) {
      // ts > end happens after a replay restart/seek: the log still holds the previous pass.
      if (ev.data.ts < start || ev.data.ts > end) continue;
      const t = tickFor(ev);
      if (t) out.push({ ts: ev.data.ts, ...t });
    }
    // Majors last so verdicts draw on top of neutral ticks.
    return out.sort((a, b) => Number(a.major) - Number(b.major));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logVersion, start, end]);

  const scrubbing = scrubTs != null;
  const value = scrubbing ? Math.min(Math.max(scrubTs, start), end) : end;
  const pct = (ts: number) => `${(((ts - start) / span) * 100).toFixed(3)}%`;
  const hasData = end > 0;

  const tsAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return start + f * span;
  };
  /** Dropping the handle at the right edge means live. */
  const scrubTo = (ts: number) => setScrubTs(ts >= end - span * 0.005 ? null : Math.max(start, ts));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!hasData || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    setDragging(true);
    scrubTo(tsAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!hasData) return;
    const ts = tsAt(e.clientX);
    setHoverTs(ts);
    if (dragging) scrubTo(ts);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!hasData) return;
    const step = e.shiftKey ? 30 : 5;
    let next: number | null | undefined;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = value - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = value + step;
        break;
      case "PageDown":
        next = value - 60;
        break;
      case "PageUp":
        next = value + 60;
        break;
      case "Home":
        next = start;
        break;
      case "End":
        next = null;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next == null) setScrubTs(null);
    else scrubTo(next);
  };

  const showPlayer = mode.mode !== "live" && pb.active;
  const ended = pb.active && !pb.playing && !pb.loop && pb.position >= pb.duration;

  return (
    <footer className="timeline" data-scrubbing={scrubbing || undefined} aria-label="Event timeline">
      {showPlayer && (
        <div className="tl-player">
          <button
            type="button"
            className="tl-btn tl-play"
            onClick={() => (ended ? playback.restart() : playback.toggle())}
            aria-label={pb.playing ? "Pause playback" : ended ? "Play again from the start" : "Play"}
          >
            {pb.playing ? <PauseIcon /> : <PlayIcon />}
            <span>{pb.playing ? "Pause" : ended ? "Play again" : "Play"}</span>
          </button>
          <label className="tl-speed">
            <span className="tl-speed-label">Speed</span>
            <select className="mono" value={pb.speed} onChange={(e) => playback.setSpeed(Number(e.target.value))}>
              {(SPEEDS.includes(pb.speed as (typeof SPEEDS)[number]) ? SPEEDS : [...SPEEDS, pb.speed].sort((a, b) => a - b)).map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <span className="tl-edge mono" aria-hidden>
        {hasData ? ago(span) : ""}
      </span>

      <div
        ref={trackRef}
        className="tl-track"
        role="slider"
        tabIndex={hasData ? 0 : -1}
        aria-label="Scrub through recent events"
        aria-valuemin={Math.floor(start)}
        aria-valuemax={Math.ceil(end)}
        aria-valuenow={Math.round(value)}
        aria-valuetext={scrubbing ? `${agoWords(end - value)}, ${wallClock(value)}` : `${headWord}, ${hasData ? wallClock(end) : "waiting for events"}`}
        aria-disabled={!hasData || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHoverTs(null)}
        onKeyDown={onKeyDown}
      >
        <div className="tl-rail" />
        {hasData && (
          <>
            <div className="tl-past" style={{ width: pct(value) }} />
            {ticks.map((t, i) => (
              <span key={i} className={`tl-tick tl-${t.tone}${t.major ? " tl-major" : ""}`} style={{ left: pct(t.ts) }} />
            ))}
            {hoverTs != null && !dragging && (
              <span className="tl-hover" style={{ left: pct(hoverTs) }}>
                <span className="tl-hover-label mono">{ago(end - hoverTs)}</span>
              </span>
            )}
            <span className={`tl-handle${dragging ? " is-dragging" : ""}`} style={{ left: pct(value) }} aria-hidden />
          </>
        )}
      </div>

      <span className="tl-edge mono" aria-hidden>
        now
      </span>

      <div className="tl-readout" aria-live="off">
        {!hasData ? (
          <span className="tl-dim">Waiting for events</span>
        ) : scrubbing ? (
          <>
            <span className="mono tl-rel">{ago(end - value)}</span>
            <span className="mono tl-dim">{wallClock(value)}</span>
          </>
        ) : (
          <>
            <span className="tl-live">{headWord}</span>
            <span className="mono tl-dim">{wallClock(end)}</span>
          </>
        )}
      </div>

      {scrubbing && (
        <button type="button" className="tl-btn tl-back" onClick={() => setScrubTs(null)}>
          {mode.mode === "live" ? "Back to live" : "Back to latest"}
        </button>
      )}
    </footer>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="1.5" width="2.5" height="9" rx="0.5" fill="currentColor" />
      <rect x="7" y="1.5" width="2.5" height="9" rx="0.5" fill="currentColor" />
    </svg>
  );
}
