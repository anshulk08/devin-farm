// Small shared pieces: status pill, session avatar, mode pill.
import type { CSSProperties } from "react";
import { useFarm } from "../state/store";
import type { Pill as PillT } from "./model";

export function Pill({ pill }: { pill: PillT }) {
  return <span className={`pill pill-${pill.kind}`}>{pill.label}</span>;
}

export function Avatar({ letter, hue, size = "md" }: { letter: string; hue: string; size?: "sm" | "md" }) {
  return (
    <span className={`avatar avatar-${size}`} style={{ "--hue": hue } as CSSProperties} aria-hidden>
      {letter}
    </span>
  );
}

/** Live / Mock data / Replay. Only a real feed may say Live. */
export function ModePill() {
  const { mode, scrubTs, live } = useFarm();
  const kind = scrubTs != null || mode.mode === "replay" ? "replay" : mode.mode === "mock" || live.feedMock ? "mock" : live.connection === "open" ? "live" : "lost";
  const text = { live: "Live", replay: "Replay", mock: "Mock data", lost: "Reconnecting" }[kind];
  return (
    <span className={`mode-pill mode-${kind}`} role="status" aria-label={`Feed: ${text}`}>
      <span className="mode-dot" aria-hidden />
      {text}
    </span>
  );
}
