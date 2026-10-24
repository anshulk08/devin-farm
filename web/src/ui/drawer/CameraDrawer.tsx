// Camera drawer: fps, status, the boards it watches.
import { useFarm } from "../../state/store";
import type { GNode } from "../../state/types";
import { fmtNum } from "../panels-shared/format";

export function CameraDrawer({ node, onSelect }: { node: GNode; onSelect: (id: string) => void }) {
  const { state } = useFarm();
  const watched = Object.values(state.edges)
    .filter((e) => e.kind === "watches" && e.source === node.id)
    .map((e) => state.nodes[e.target])
    .filter((n): n is GNode => !!n);
  const fps = typeof node.data.fps === "number" ? node.data.fps : undefined;
  const ok = node.status === "ok";
  const verifying = watched.filter((n) => state.devices[n.id]?.verifying);

  return (
    <>
      <section className="dsec">
        <dl className="facts">
          <dt>Status</dt>
          <dd className={ok ? "" : "v-warn"}>{ok ? "Working" : node.status === "down" ? "Down" : node.status}</dd>
          <dt>Frame rate</dt>
          <dd className="mono">{fps != null ? `${fmtNum(fps, 1)} fps` : "—"}</dd>
          {node.parent && (
            <>
              <dt>Rig</dt>
              <dd>
                <button type="button" className="row-btn" onClick={() => onSelect(node.parent!)}>
                  <span className="row-main">{state.nodes[node.parent]?.label ?? node.parent}</span>
                </button>
              </dd>
            </>
          )}
          <dt>Verifying</dt>
          <dd>{verifying.length ? verifying.map((n) => n.label).join(", ") : "Nothing right now"}</dd>
        </dl>
      </section>
      <section className="dsec" aria-labelledby="c-watch">
        <h3 className="dsec-h" id="c-watch">
          Watches
          <span className="pnote mono">{watched.length} boards</span>
        </h3>
        {watched.length === 0 && <p className="empty">No calibrated boards. A board needs calibration before the camera can verify it.</p>}
        <ul className="rows">
          {watched.map((n) => (
            <li key={n.id}>
              <button type="button" className="row-btn" onClick={() => onSelect(n.id)}>
                <span className="row-main">{n.label}</span>
                <span className="row-meta">{n.status}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
