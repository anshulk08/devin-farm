// Rig drawer: health, temp/load sparklines from rigHistory, maintenance toggle, device list.
import { useState } from "react";
import { useFarm } from "../../state/store";
import type { GNode } from "../../state/types";
import { cameraOf, devicesOf, leaseOn, sessionHue } from "../../state/selectors";
import { api, PUBLIC } from "../../data/api";
import { fmtNum, fmtTime, rigName, sparkPath } from "../panels-shared/format";
import { useAsyncAction, useMutationGate } from "../panels-shared/hooks";

export function RigDrawer({ node, onSelect }: { node: GNode; onSelect: (id: string) => void }) {
  const { state } = useFarm();
  const d = node.data;
  const offline = node.status === "offline";
  const hist = state.rigHistory[node.id] ?? [];
  const devices = devicesOf(state, node.id);
  const cam = cameraOf(state, node.id);
  const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : undefined);
  const temp = num("temp_c");
  const load = num("load1");
  const mem = num("mem_free_mb");

  return (
    <>
      <section className="dsec" aria-labelledby="r-health">
        <h3 className="dsec-h" id="r-health">
          Health
          {typeof d.last_seen === "number" && (
            <span className="pnote">
              updated <span className="mono">{fmtTime(d.last_seen)}</span>
            </span>
          )}
        </h3>
        <dl className="facts">
          <dt>Status</dt>
          <dd className={offline ? "v-off" : ""}>{offline ? "Offline" : d.maintenance ? "Online, in maintenance" : "Online"}</dd>
          {typeof d.model === "string" && (
            <>
              <dt>Host</dt>
              <dd>{d.mock ? "Mock drivers (no real boards)" : d.model}</dd>
            </>
          )}
          <dt>Temperature</dt>
          <dd className="mono">{temp != null ? `${fmtNum(temp, 1)} °C` : "—"}</dd>
          <dt>Load (1 min)</dt>
          <dd className="mono">{load != null ? fmtNum(load) : "—"}</dd>
          <dt>Memory free</dt>
          <dd className="mono">{mem != null ? `${fmtNum(mem, 0)} MB` : "—"}</dd>
          <dt>Throttled</dt>
          <dd className={d.throttled ? "v-warn" : ""}>{d.throttled ? "Yes" : "No"}</dd>
          <dt>Camera</dt>
          <dd className={d.camera_ok === false ? "v-warn" : ""}>{d.camera_ok === false ? "Down" : "Working"}</dd>
          <dt>Verifier</dt>
          <dd className={d.verifier_online === false ? "v-warn" : ""}>{d.verifier_online === false ? "Not running" : "Running"}</dd>
        </dl>
      </section>

      <section className="dsec" aria-labelledby="r-hist">
        <h3 className="dsec-h" id="r-hist">
          History
          <span className="pnote mono">{hist.length} samples</span>
        </h3>
        {hist.length < 2 ? (
          <p className="empty">Not enough health samples yet. One arrives every few seconds while the rig is online.</p>
        ) : (
          <>
            <Sparkline label="Temperature" values={hist.map((h) => h.temp_c)} unit="°C" digits={1} color="var(--s3)" />
            <Sparkline label="Load (1 min)" values={hist.map((h) => h.load1)} unit="" digits={2} color="var(--s4)" />
          </>
        )}
      </section>

      {!PUBLIC && <Maintenance rigId={rigName(node.id)} on={!!d.maintenance} />}

      <section className="dsec" aria-labelledby="r-devs">
        <h3 className="dsec-h" id="r-devs">Boards on this rig</h3>
        {devices.length === 0 && <p className="empty">No boards attached.</p>}
        <ul className="rows">
          {devices.map((dev) => {
            const lease = leaseOn(state, dev.id);
            return (
              <li key={dev.id}>
                <button type="button" className="row-btn" onClick={() => onSelect(dev.id)}>
                  <span
                    className="row-swatch"
                    style={{ background: lease ? sessionHue(lease.source) : dev.status === "offline" ? "var(--off)" : "var(--line-strong)" }}
                    aria-hidden
                  />
                  <span className="row-main">{dev.label}</span>
                  <span className="row-meta">{lease ? state.nodes[lease.source]?.label ?? "leased" : dev.status}</span>
                </button>
              </li>
            );
          })}
          {cam && (
            <li>
              <button type="button" className="row-btn" onClick={() => onSelect(cam.id)}>
                <span className="row-swatch" style={{ background: "var(--text-dim)" }} aria-hidden />
                <span className="row-main">Camera {cam.label}</span>
                <span className="row-meta">{cam.status}</span>
              </button>
            </li>
          )}
        </ul>
      </section>
    </>
  );
}

function Sparkline({ label, values, unit, digits, color }: { label: string; values: number[]; unit: string; digits: number; color: string }) {
  const W = 360;
  const H = 44;
  const { d, min, max } = sparkPath(values, W, H, 3);
  const last = values[values.length - 1];
  const u = unit ? ` ${unit}` : "";
  return (
    <div className="spark">
      <span className="spark-label">{label}</span>
      <span className="spark-now">
        {fmtNum(last, digits)}
        {u}
      </span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, last ${values.length} samples, ${fmtNum(min, digits)} to ${fmtNum(max, digits)}${u}`}>
        <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span className="spark-range">
        min {fmtNum(min, digits)}
        {u} · max {fmtNum(max, digits)}
        {u}
      </span>
    </div>
  );
}

function Maintenance({ rigId, on }: { rigId: string; on: boolean }) {
  const gate = useMutationGate();
  // Optimistic until the next graph/health update carries the new flag.
  const [want, setWant] = useState<boolean | null>(null);
  const { state, run } = useAsyncAction((next: boolean) => api.maintenance(rigId, next));
  const shown = want ?? on;
  if (want !== null && want === on && state.status !== "busy") setWant(null);

  return (
    <section className="dsec" aria-labelledby="r-maint">
      <h3 className="dsec-h" id="r-maint">Maintenance</h3>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={shown}
        disabled={!gate.ok || state.status === "busy"}
        title={gate.reason}
        onClick={async () => {
          const next = !shown;
          setWant(next);
          const r = await run(next);
          if (r === undefined) setWant(null);
        }}
      >
        <span className="switch-track" aria-hidden />
        {shown ? "In maintenance: no new leases are granted" : "Accepting leases"}
      </button>
      {state.status === "error" && <p className="perror" role="alert">Could not change maintenance: {state.error}</p>}
    </section>
  );
}
