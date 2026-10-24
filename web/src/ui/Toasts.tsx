// Verdict and lease toasts, bottom-left above the timeline. Click jumps to the node; each one leaves after 6 s.
import { useEffect, useRef } from "react";
import { useFarm } from "../state/store";
import type { Toast } from "../state/reducer";
import "./Toasts.css";

export const TOAST_MS = 6000;

const TONE_LABEL: Record<Toast["tone"], string> = {
  pass: "Confirmed by camera",
  fail: "Contradicted by camera",
  self: "Self-reported only",
  info: "Lease",
};

function Icon({ tone }: { tone: Toast["tone"] }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg className="toast-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {tone === "pass" && <path d="M3 8.5l3.2 3L13 4.5" {...p} />}
      {tone === "fail" && <path d="M4 4l8 8M12 4l-8 8" {...p} />}
      {tone === "self" && <path d="M8 3.5v5.5M8 12.2v.3" {...p} />}
      {tone === "info" && <circle cx="8" cy="8" r="3" {...p} />}
    </svg>
  );
}

export function Toasts({ onSelect }: { onSelect: (id: string) => void }) {
  // Toasts come from the live store: dismissals go there, and scrubbing the timeline should not resurrect old ones.
  const { live, dispatch } = useFarm();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const t = timers.current;
    const ids = new Set(live.toasts.map((x) => x.id));
    for (const toast of live.toasts) {
      if (!t.has(toast.id)) t.set(toast.id, setTimeout(() => dispatch({ type: "dismissToast", id: toast.id }), TOAST_MS));
    }
    for (const [id, h] of t) {
      if (!ids.has(id)) {
        clearTimeout(h);
        t.delete(id);
      }
    }
  }, [live.toasts, dispatch]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  return (
    <section className="toasts" aria-label="Notifications" aria-live="polite">
      {live.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <button
            type="button"
            className="toast-main"
            onClick={() => {
              onSelect(t.nodeId);
              dispatch({ type: "dismissToast", id: t.id });
            }}
            title="Show this board"
          >
            <Icon tone={t.tone} />
            <span className="toast-body">
              <span className="toast-tone">{TONE_LABEL[t.tone]}</span>
              <span className="toast-text">{t.text}</span>
            </span>
          </button>
          <button type="button" className="toast-x" aria-label="Dismiss notification" onClick={() => dispatch({ type: "dismissToast", id: t.id })}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </section>
  );
}
