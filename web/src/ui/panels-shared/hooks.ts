// Small hooks shared by the drawers, the modal and the command bar.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useFarm } from "../../state/store";
import { gateReason } from "./format";

/** Mutating controls only hit the network in live mode and at "now". `reason` explains why not. */
export function useMutationGate(): { ok: boolean; reason: string | undefined } {
  const { mode, scrubTs } = useFarm();
  const reason = gateReason(mode.mode, scrubTs) ?? undefined;
  return { ok: reason === undefined, reason };
}

/**
 * Seconds "now" for countdowns. Uses state.now (latest event ts) so replays stay consistent;
 * in live mode at the head of the timeline it also ticks with the wall clock between events.
 */
export function useNow(): number {
  const { state, mode, scrubTs } = useFarm();
  const ticking = mode.mode === "live" && scrubTs == null;
  const [wall, setWall] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setWall(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return ticking ? Math.max(state.now, wall) : state.now;
}

export type AsyncState<T> = { status: "idle" } | { status: "busy" } | { status: "done"; value: T } | { status: "error"; error: string };

/** Run one async action at a time and expose its state. Ignores results after unmount. */
export function useAsyncAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [st, setSt] = useState<AsyncState<T>>({ status: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async (...args: A): Promise<T | undefined> => {
      setSt({ status: "busy" });
      try {
        const value = await fn(...args);
        if (alive.current) setSt({ status: "done", value });
        return value;
      } catch (e) {
        if (alive.current) setSt({ status: "error", error: e instanceof Error ? e.message : String(e) });
        return undefined;
      }
    },
    [fn],
  );
  const reset = useCallback(() => setSt({ status: "idle" }), []);
  return { state: st, run, reset };
}

// Open traps, innermost last. Only the innermost one handles keys and focus, so a dialog opened over
// another (⌘K over New session) does not fight it for focus.
const trapStack: HTMLElement[] = [];
const isTop = (el: HTMLElement) => trapStack[trapStack.length - 1] === el;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus trap for a modal dialog: focuses [data-autofocus] (or the first focusable) on open,
 * cycles Tab inside, handles Escape without letting it reach the app-level handler, restores focus on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const before = document.activeElement as HTMLElement | null;
    trapStack.push(el);
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop(el)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        escRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (i <= 0)) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    // Backstop for cases the Tab wrap misses (radio groups, browser chrome): pull focus back inside.
    const onFocusIn = (e: FocusEvent) => {
      if (isTop(el) && e.target instanceof Node && !el.contains(e.target)) {
        (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      const i = trapStack.lastIndexOf(el);
      if (i >= 0) trapStack.splice(i, 1);
      before?.focus?.();
    };
  }, [ref, active]);
}
