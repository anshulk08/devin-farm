import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const RM_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeRM(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(RM_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeRM,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(RM_QUERY).matches : false),
    () => false,
  );
}

// One shared 1 s ticker for every subscriber (thumbnail refresh, countdowns), so N devices cost one interval.
let tick = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeTick(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      tick++;
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noSub = () => () => {};

/** Seconds counter that advances once a second while `on`; constant otherwise. */
export function useSecondTick(on: boolean): number {
  return useSyncExternalStore(on ? subscribeTick : noSub, () => tick, () => 0);
}

/**
 * Display clock in event time (Unix s). `state.now` only moves when an event arrives, so between events we
 * advance it by wall time; when paused (timeline scrubbed) it is exactly `stateNow`.
 */
export function useEventClock(stateNow: number, paused: boolean): number {
  const anchor = useRef({ now: stateNow, wall: Date.now() });
  if (anchor.current.now !== stateNow) anchor.current = { now: stateNow, wall: Date.now() };
  useSecondTick(!paused);
  if (paused) return stateNow;
  return anchor.current.now + (Date.now() - anchor.current.wall) / 1000;
}

/** Returns `value` while it is fresh; `null` after `ms`. Restarts whenever `key` changes (not on first mount). */
export function useFlash<T>(key: string | undefined, value: T, ms: number): T | null {
  const seen = useRef(key);
  const [flash, setFlash] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (key === seen.current) return;
    seen.current = key;
    if (!key) {
      // Verdict cleared (e.g. scrubbed back before it): drop any flash still showing.
      setFlash(null);
      return;
    }
    setFlash({ key, value });
    const t = setTimeout(() => setFlash(null), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return flash ? flash.value : null;
}
