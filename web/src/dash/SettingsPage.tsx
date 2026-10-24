// Settings: what this page is connected to. Nothing here mutates the farm.
import { useFarm } from "../state/store";
import { PUBLIC } from "../data/api";

export function SettingsPage() {
  const { mode, live } = useFarm();
  const rows: [string, string][] = [
    ["Feed", mode.mode === "live" ? "Live from farm-control" : mode.mode === "mock" ? "Mock data (scripted demo)" : "Replay of a recording"],
    ["Source", mode.mode === "live" ? (PUBLIC ? "/pub/events" : "/api/events") : mode.url ?? "–"],
    ["Connection", live.connection === "open" ? "Connected" : live.connection === "connecting" ? "Connecting" : "Reconnecting"],
    ["View", PUBLIC ? "Public, read-only" : "Operator"],
  ];
  return (
    <div className="dash">
      <header className="dash-head">
        <h1 className="dash-title">Settings</h1>
      </header>
      <section className="dash-sec">
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === "Source" ? "mono" : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="empty">
          Switch feeds with the address bar: <code>?mock=1</code> plays the scripted demo, <code>?replay=&lt;name&gt;</code> plays a recording, and{" "}
          <code>?view=graph</code> opens the bubble graph.
        </p>
      </section>
    </div>
  );
}
