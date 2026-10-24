import { useEffect, useState } from "react";
import { useFarm } from "../state/store";
import { api, PUBLIC } from "../data/api";
import "./TopBar.css";

function ModeBadge() {
  const { mode, scrubTs, live } = useFarm();
  const kind = scrubTs != null || mode.mode === "replay" ? "replay" : mode.mode === "mock" || live.feedMock ? "mock" : "live";
  const text = { live: "Live", replay: "Replay", mock: "Mock data" }[kind];
  return (
    <span className={`badge badge-${kind}`} role="status" aria-label={`Mode: ${text}`}>
      <span className="badge-dot" aria-hidden />
      {text}
    </span>
  );
}

function Budget() {
  const { mode, live } = useFarm();
  const [b, setB] = useState<{ acus_used: number; acus_cap: number } | null>(null);
  useEffect(() => {
    if (PUBLIC || mode.mode !== "live") return;
    let alive = true;
    const tick = () => api.budget().then((r) => alive && setB(r)).catch(() => {});
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mode.mode]);
  // Off-live: sum session ACUs so the number still means something.
  const used = b?.acus_used ?? Object.values(live.nodes).reduce((a, n) => a + (n.kind === "session" ? Number(n.data.acus ?? 0) : 0), 0);
  const cap = b?.acus_cap ?? 50;
  return (
    <span className="budget" title="ACUs used across all sessions, against the global cap">
      <span className="mono">{used.toFixed(1)}</span>
      <span className="budget-sep">/</span>
      <span className="mono">{cap}</span> ACU
    </span>
  );
}

export function TopBar({ onNewSession, onCommand }: { onNewSession: () => void; onCommand: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <ModeBadge />
        <span className="brand">Devin Farm</span>
      </div>
      <div className="topbar-right">
        {!PUBLIC && <Budget />}
        <button className="kbd-hint" onClick={onCommand} aria-label="Open command bar">
          <kbd>⌘K</kbd>
        </button>
        {!PUBLIC && (
          <button className="btn-primary" onClick={onNewSession}>
            New session
          </button>
        )}
      </div>
    </header>
  );
}
