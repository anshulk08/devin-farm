// Activity timeline (reference design): play/pause, a track of event ticks in session colours,
// a draggable playhead, and the playhead's distance from now. Same store scrub as ui/Timeline.
import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useFarm, LOG_WINDOW_S } from "../state/store";
import { verdictTone } from "../state/reducer";
import { clock, sessionHue } from "../state/selectors";
import { ids } from "../state/types";
import type { FarmEvent } from "../state/types";
import { playback } from "../data/player";
import { ModePill } from "./parts";
import { Pause, Play } from "./Icons";

const RANGES = [
  { s: 5 * 60, label: "5 min" },
  { s: 15 * 60, label: "15 min" },
  { s: LOG_WINDOW_S, label: "30 min" },
];

interface Tick {
  ts: number;
  color: string;
  major: boolean;
}

function tickFor(ev: FarmEvent): Omit<Tick, "ts"> | null {
  switch (ev.name) {
    case "verify": {
      if (ev.data.state === "pending") return null;
      const tone = ev.data.state === "error" ? "self" : verdictTone(ev.data.results ?? []);
      return { color: tone === "pass" ? "var(--ok)" : tone === "fail" ? "var(--bad)" : "var(--warn)", major: true };
    }
    case "lease":
      if (ev.data.event === "renewed") return null;
      return { color: sessionHue(ids.sessionFromHolder(ev.data.holder)), major: ev.data.event === "granted" };
    case "session":
      return { color: sessionHue(ids.session(ev.data.farm_id)), major: false };
    case "session_message":
      return { color: sessionHue(ids.session(ev.data.farm_id)), major: false };
    case "run":
    case "device":
      return { color: "var(--line-strong)", major: false };
    default:
      return null;
  }
}

const ago = (s: number) => (s < 0.5 ? "now" : `-${clock(s)}`);

export function ActivityTimeline() {
  const { live, log, logVersion, scrubTs, setScrubTs, mode } = useFarm();
  const pb = useSyncExternalStore(playback.subscribe, playback.getSnapshot, playback.getSnapshot);
  const [range, setRange] = useState(RANGES[2].s);
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  const end = live.now;
  const first = log.length ? log[0].data.ts : end;
  const start = Math.min(Math.max(end - range, first), end - 60);
  const span = end - start;
  const has = end > 0;

  const ticks = useMemo(() => {
    const out: Tick[] = [];
    let last = -Infinity;
    for (const ev of log) {
      if (ev.data.ts < start || ev.data.ts > end) continue;
      const t = tickFor(ev);
      if (!t) continue;
      // thin out dense minor ticks so the track stays readable
      if (!t.major && ev.data.ts - last < span / 160) continue;
      if (!t.major) last = ev.data.ts;
      out.push({ ts: ev.data.ts, ...t });
    }
    return out.sort((a, b) => Number(a.major) - Number(b.major));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logVersion, start, end]);

  const scrubbing = scrubTs != null;
  const value = scrubbing ? Math.min(Math.max(scrubTs, start), end) : end;
  const pct = (ts: number) => `${(((ts - start) / span) * 100).toFixed(3)}%`;

  const tsAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return start + Math.min(1, Math.max(0, (x - r.left) / r.width)) * span;
  };
  const scrubTo = (ts: number) => setScrubTs(ts >= end - span * 0.005 ? null : Math.max(start, ts));

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!has || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    setDragging(true);
    scrubTo(tsAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => dragging && scrubTo(tsAt(e.clientX));
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!has) return;
    const step = e.shiftKey ? 30 : 5;
    const map: Record<string, number | null> = { ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step, Home: start, End: null };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = map[e.key];
    if (next == null) setScrubTs(null);
    else scrubTo(next);
  };

  // Play/pause: drives the player in mock/replay; in live it freezes the view (pause) or returns to now (play).
  const isPlayer = mode.mode !== "live" && pb.active;
  const playing = isPlayer ? pb.playing && !scrubbing : !scrubbing;
  const toggle = () => {
    if (isPlayer) {
      if (scrubbing) setScrubTs(null);
      if (!pb.playing && pb.position >= pb.duration && !pb.loop) playback.restart();
      else if (!(scrubbing && pb.playing)) playback.toggle();
    } else {
      setScrubTs(scrubbing ? null : end);
    }
  };

  return (
    <section className="dash-sec atl" aria-labelledby="h-activity">
      <div className="atl-head">
        <h2 id="h-activity" className="sec-title">
          Activity timeline
        </h2>
        <div className="atl-tools">
          <ModePill />
          <label className="atl-range">
            <span className="sr-only">Time range</span>
            <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.s} value={r.s}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="atl-row">
        <button type="button" className="atl-play" onClick={toggle} disabled={!has} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause /> : <Play />}
        </button>
        <div
          ref={track}
          className="atl-track"
          role="slider"
          tabIndex={has ? 0 : -1}
          aria-label="Scrub through recent activity"
          aria-valuemin={Math.floor(start)}
          aria-valuemax={Math.ceil(end)}
          aria-valuenow={Math.round(value)}
          aria-valuetext={scrubbing ? `${clock(end - value)} ago` : "Now"}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          <div className="atl-rail" />
          {has &&
            ticks.map((t, i) => <span key={i} className={`atl-tick${t.major ? " major" : ""}`} style={{ left: pct(t.ts), "--c": t.color } as CSSProperties} />)}
          {has && (
            <span className={`atl-head-line${dragging ? " drag" : ""}`} style={{ left: pct(value) }} aria-hidden>
              <span className="atl-knob" />
            </span>
          )}
        </div>
        <span className="atl-ago mono">{has ? ago(end - value) : "–"}</span>
      </div>
    </section>
  );
}
