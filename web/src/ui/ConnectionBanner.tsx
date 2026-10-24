import { useFarm } from "../state/store";

/** SSE loss never blanks the screen: the last graph stays, greyed, under this banner. */
export function ConnectionBanner() {
  const { live, mode } = useFarm();
  if (mode.mode !== "live" || live.connection === "open") return null;
  const text = live.connection === "connecting" ? "Connecting to farm-control…" : "Reconnecting… showing the last known state";
  return (
    <div className="conn-banner" role="status">
      {text}
      <style>{`.conn-banner{position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:6;background:var(--panel-2);border:1px solid var(--warn);color:var(--warn);padding:6px 14px;border-radius:999px;font-size:var(--fs-xs);font-weight:600}.app:has(.conn-banner) .canvas{filter:grayscale(.8) brightness(.75)}`}</style>
    </div>
  );
}
