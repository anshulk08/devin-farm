// Plays an ndjson recording/fixture with real relative timing (FRONTEND §8).
// One JSON FarmEvent per line: {"name": ..., "data": {..., "ts": <unix s>}}.
//
// - mock (`loop: true`): loops forever; every pass is re-based onto the wall clock so timestamps keep
//   increasing across loops and timers/wall-clock labels read as "now".
// - replay (`loop: false`): keeps the recording's own timestamps and stops at the end.
//
// The Timeline drives the active player through the module-level `playback` controller.
import type { FarmEvent } from "../state/types";
import type { FeedHandlers, FeedSource } from "./source";

export interface PlayerOptions {
  loop?: boolean;
  /** Playback rate; default from `?speed=N`, else 1. */
  speed?: number;
  /** Shift timestamps so the first event lands at wall-clock now. Default: same as `loop`. */
  rebase?: boolean;
}

export interface PlaybackState {
  /** A player is mounted and has loaded its file. */
  active: boolean;
  playing: boolean;
  speed: number;
  /** Seconds into the recording (0 … duration). */
  position: number;
  duration: number;
  loop: boolean;
  /** Completed passes (mock loops). */
  pass: number;
}

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

/** Parse an ndjson body into events. Blank lines are skipped; bad lines are reported and skipped. */
export function parseNdjson(text: string): FarmEvent[] {
  const events: FarmEvent[] = [];
  text.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (!l) return;
    try {
      const ev = JSON.parse(l) as FarmEvent;
      if (ev && typeof ev.name === "string" && ev.data && typeof ev.data.ts === "number") events.push(ev);
      else console.warn(`[player] line ${i + 1}: not a FarmEvent`);
    } catch {
      console.warn(`[player] line ${i + 1}: bad JSON`);
    }
  });
  return events;
}

/** Copy an event with every timestamp moved by `dt` seconds (ts, and expires_at on leases). */
export function shiftEvent(ev: FarmEvent, dt: number): FarmEvent {
  if (dt === 0) return ev;
  const data = { ...ev.data, ts: ev.data.ts + dt } as Record<string, unknown>;
  if (typeof data.expires_at === "number") data.expires_at = (data.expires_at as number) + dt;
  if (ev.name === "graph_snapshot") {
    data.edges = ev.data.edges.map((e) =>
      e.data?.expires_at != null ? { ...e, data: { ...e.data, expires_at: e.data.expires_at + dt } } : e,
    );
  }
  return { name: ev.name, data } as unknown as FarmEvent;
}

function speedFromLocation(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const n = Number(new URLSearchParams(window.location.search).get("speed"));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---- module-level controller for the Timeline ----

interface Controls {
  pause: () => void;
  resume: () => void;
  setSpeed: (n: number) => void;
  seek: (position: number) => void;
}

const IDLE: PlaybackState = { active: false, playing: false, speed: 1, position: 0, duration: 0, loop: false, pass: 0 };
let current: PlaybackState = IDLE;
let controls: Controls | null = null;
const listeners = new Set<() => void>();

function publish(next: PlaybackState) {
  current = next;
  listeners.forEach((l) => l());
}

export const playback = {
  /** For useSyncExternalStore. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Stable between changes (safe for useSyncExternalStore). Position updates on events, not per frame. */
  getSnapshot(): PlaybackState {
    return current;
  },
  pause: () => controls?.pause(),
  resume: () => controls?.resume(),
  toggle: () => (current.playing ? controls?.pause() : controls?.resume()),
  setSpeed: (n: number) => controls?.setSpeed(n),
  /** Restart and fast-forward to `position` seconds into the recording. */
  seek: (position: number) => controls?.seek(position),
  restart: () => controls?.seek(0),
};

// ---- player ----

export function createPlayer(url: string, opts: PlayerOptions = {}): FeedSource {
  const loop = opts.loop ?? false;
  const rebase = opts.rebase ?? loop;

  return (h: FeedHandlers) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let events: FarmEvent[] = [];
    let t0 = 0; // first ts of the recording
    let duration = 0;
    let idx = 0; // next event to emit
    let offset = 0; // added to every ts this pass
    let pass = 0;
    let lastTs = -Infinity; // last emitted (shifted) ts; rebased passes never go backwards
    let speed = opts.speed ?? speedFromLocation() ?? 1;
    let playing = true;
    // Playback clock: position (s into the recording) = anchorPos + (wall - anchorWall) * speed
    let anchorPos = 0;
    let anchorWall = 0;

    const wall = () => Date.now();
    const position = () => (playing ? anchorPos + ((wall() - anchorWall) / 1000) * speed : anchorPos);
    const reanchor = (pos = position()) => {
      anchorPos = pos;
      anchorWall = wall();
    };
    const state = (): PlaybackState => ({ active: true, playing, speed, position: Math.min(duration, Math.max(0, anchorPos)), duration, loop, pass });
    const report = () => publish(state());
    const clear = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
    };

    const emit = (ev: FarmEvent) => {
      const out = shiftEvent(ev, offset);
      lastTs = Math.max(lastTs, out.data.ts);
      h.onEvent(out);
    };
    /** Offset that puts recording position `pos` at wall-clock now; events from `pos` on never go behind what was emitted. */
    const rebaseOffset = (pos: number) => Math.max(wall() / 1000, lastTs) - t0 - pos;
    /** Offset for a fresh pass that fast-forwards to `pos`: the whole pass starts at or after the last emitted ts. */
    const passOffset = (pos: number) => Math.max(wall() / 1000 - pos, lastTs) - t0;

    const startPass = (fromPos = 0) => {
      offset = rebase ? passOffset(fromPos) : 0;
      idx = 0;
      h.onReset();
      // Fast-forward everything up to fromPos instantly (seek), then play in real time.
      while (idx < events.length && events[idx].data.ts - t0 <= fromPos) emit(events[idx++]);
      reanchor(fromPos);
      report();
      schedule();
    };

    const schedule = () => {
      clear();
      if (stopped || !playing) return;
      if (idx >= events.length) {
        if (loop) {
          // Small pause at the end so the final state reads before the loop restarts.
          // (Count the pass only when it actually restarts: pause/speed changes re-enter here.)
          timer = setTimeout(() => {
            pass++;
            startPass(0);
          }, 3000 / speed);
        } else {
          playing = false;
          reanchor(duration);
          report();
        }
        return;
      }
      const due = events[idx].data.ts - t0;
      const delay = Math.max(0, ((due - position()) / speed) * 1000);
      timer = setTimeout(tick, delay);
    };

    const tick = () => {
      timer = null;
      if (stopped || !playing) return;
      const pos = position();
      // Emit every event that is due (same-ts batches go out together).
      while (idx < events.length && events[idx].data.ts - t0 <= pos + 1e-6) emit(events[idx++]);
      reanchor(pos);
      report();
      schedule();
    };

    const ctl: Controls = {
      pause: () => {
        if (!playing) return;
        reanchor();
        playing = false;
        clear();
        report();
      },
      resume: () => {
        if (playing) return;
        if (!loop && idx >= events.length) return startPassPlaying(0);
        playing = true;
        // Rebased mocks: keep ts continuous with the wall clock after a pause.
        if (rebase) offset = Math.max(offset, rebaseOffset(anchorPos));
        reanchor(anchorPos);
        report();
        schedule();
      },
      setSpeed: (n: number) => {
        if (!(n > 0)) return;
        reanchor();
        speed = n;
        report();
        schedule();
      },
      seek: (pos: number) => {
        clear();
        startPassPlaying(Math.min(duration, Math.max(0, pos)));
      },
    };
    const startPassPlaying = (pos: number) => {
      playing = true;
      startPass(pos);
    };

    h.onConnection("connecting");
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        events = parseNdjson(await res.text());
        if (events.length === 0) throw new Error("empty recording");
      } catch (err) {
        if (stopped) return;
        console.warn("[player] could not load", url, err);
        h.onConnection("lost");
        return;
      }
      if (stopped) return;
      events.sort((a, b) => a.data.ts - b.data.ts); // stable: keeps file order within a ts
      t0 = events[0].data.ts;
      duration = events[events.length - 1].data.ts - t0;
      controls = ctl;
      h.onConnection("open");
      startPass(0);
    })();

    return () => {
      stopped = true;
      clear();
      if (controls === ctl) {
        controls = null;
        publish(IDLE);
      }
    };
  };
}
