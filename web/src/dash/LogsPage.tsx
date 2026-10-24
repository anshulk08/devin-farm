// Event log: the store's buffered events, newest first. Read-only.
import { useMemo } from "react";
import { useFarm } from "../state/store";
import type { FarmEvent } from "../state/types";
import { fmtTime } from "../ui/panels-shared/format";
import { verdictText } from "../state/reducer";

function describe(ev: FarmEvent): string {
  switch (ev.name) {
    case "lease":
      return `${ev.data.device}: lease ${ev.data.event} by ${ev.data.holder}${ev.data.token != null ? ` (tok ${ev.data.token})` : ""}${ev.data.position ? `, #${ev.data.position} in line` : ""}`;
    case "run":
      return `${ev.data.device}: run ${ev.data.run_id} ${ev.data.state}`;
    case "log":
      return `${ev.data.device}: ${ev.data.text}`;
    case "verify":
      return ev.data.state === "done" ? `${ev.data.device}: ${verdictText(ev.data.results ?? [])}` : `${ev.data.device}: verify ${ev.data.state}`;
    case "evidence":
      return `${ev.data.device}: evidence ${ev.data.evidence_id}`;
    case "device":
      return `${ev.data.device} is ${ev.data.status}${ev.data.holder ? ` (${ev.data.holder})` : ""}`;
    case "session":
      return `${ev.data.title}: ${ev.data.status}, ${ev.data.acus.toFixed(1)} ACU`;
    case "session_message":
      return `${ev.data.source === "user" ? "You" : "Devin"}: ${ev.data.text}`;
    case "rig_health":
      return `${ev.data.rig_id}: ${ev.data.temp_c.toFixed(1)} °C, load ${ev.data.load1.toFixed(2)}`;
    case "graph_snapshot":
      return `Snapshot: ${ev.data.nodes.length} nodes, ${ev.data.edges.length} edges`;
  }
  return JSON.stringify((ev as { data: unknown }).data);
}

export function LogsPage() {
  const { log, logVersion } = useFarm();
  const rows = useMemo(
    () => log.filter((e) => e.name !== "rig_health").slice(-300).reverse(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logVersion],
  );
  return (
    <div className="dash">
      <header className="dash-head">
        <h1 className="dash-title">Logs</h1>
      </header>
      <section className="dash-sec">
        {rows.length === 0 ? (
          <p className="empty">No events yet. They appear here as rigs and sessions report in.</p>
        ) : (
          <ol className="logs">
            {rows.map((e, i) => (
              <li key={i}>
                <span className="mono log-ts">{fmtTime(e.data.ts)}</span>
                <span className="log-kind">{e.name.replace("_", " ")}</span>
                <span className="log-text">{describe(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
