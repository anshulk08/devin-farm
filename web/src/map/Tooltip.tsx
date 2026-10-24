// Hover facts for a node or edge (FRONTEND §5). Plain rows; every number in mono with units.
import type { ReactNode } from "react";
import type { FarmState } from "../state/reducer";
import { clock, edgesOfSession, leaseOn, queueOn } from "../state/selectors";
import { holderOf, shortFarmId } from "./build";

export type HoverTarget = { kind: "node" | "edge"; id: string; x: number; y: number };

type Row = [string, ReactNode];

const M = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

function label(s: FarmState, id: string): string {
  return s.nodes[id]?.label ?? id.replace(/^[a-z]+:/, "");
}

function nodeFacts(s: FarmState, id: string, now: number): { title: string; rows: Row[] } | null {
  const n = s.nodes[id];
  if (!n) return null;
  switch (n.kind) {
    case "session": {
      const { leases, queued } = edgesOfSession(s, id);
      const rows: Row[] = [
        ["Status", n.status],
        ["ACUs", <M>{Number(n.data.acus ?? 0).toFixed(1)}</M>],
        ["Holds", leases.length ? leases.map((e) => label(s, e.target)).join(", ") : "nothing"],
      ];
      if (queued.length) rows.push(["Waiting for", queued.map((e) => `${label(s, e.target)} (#${e.data?.position ?? 1})`).join(", ")]);
      rows.push(["Farm id", <M>{String(n.data.farm_id ?? id.replace(/^session:/, ""))}</M>]);
      return { title: n.label, rows };
    }
    case "rig": {
      const d = n.data;
      const rows: Row[] = [["Status", n.status]];
      if (d.model) rows.push(["Model", String(d.model)]);
      if (typeof d.temp_c === "number") rows.push(["Temperature", <M>{d.temp_c.toFixed(1)} °C</M>]);
      if (typeof d.load1 === "number") rows.push(["Load (1 min)", <M>{d.load1.toFixed(2)}</M>]);
      if (typeof d.mem_free_mb === "number") rows.push(["Free memory", <M>{d.mem_free_mb} MB</M>]);
      if (typeof d.camera_ok === "boolean") rows.push(["Camera", d.camera_ok ? "ok" : "down"]);
      if (typeof d.verifier_online === "boolean") rows.push(["Verifier", d.verifier_online ? "online" : "offline"]);
      if (d.throttled) rows.push(["Power", "throttled"]);
      if (d.maintenance) rows.push(["Maintenance", "on"]);
      return { title: n.label, rows };
    }
    case "device": {
      const lease = leaseOn(s, id);
      const queue = queueOn(s, id);
      const rt = s.devices[id];
      const holder = holderOf(s, id);
      const rows: Row[] = [["Status", n.status]];
      if (n.data.type) rows.push(["Board", String(n.data.type)]);
      if (holder && n.status !== "free") rows.push(["Held by", `${label(s, holder)} (${shortFarmId(holder)})`]);
      if (lease?.data?.token != null) rows.push(["Fencing token", <M>{lease.data.token}</M>]);
      if (lease?.data?.expires_at != null) rows.push(["Lease left", <M>{clock(lease.data.expires_at - now)}</M>]);
      if (queue.length) rows.push(["Queue", queue.map((e) => `#${e.data?.position ?? 1} ${label(s, e.source)}`).join(", ")]);
      if (rt?.run) rows.push(["Run", `${rt.run.state} (${rt.run.run_id})`]);
      if (rt?.verifying) rows.push(["Camera", "verifying now"]);
      if (rt?.lastVerdict) {
        const v = rt.lastVerdict;
        rows.push(["Last verdict", v.tone === "pass" ? "pass, confirmed by camera" : v.tone === "fail" ? "fail" : "self-reported only"]);
      }
      if (n.data.reason) rows.push(["Reason", String(n.data.reason)]);
      return { title: n.label, rows };
    }
    case "camera": {
      const watching = Object.values(s.edges).filter((e) => e.kind === "watches" && e.source === id);
      const rows: Row[] = [
        ["Status", n.status],
        ["Watches", watching.length ? watching.map((e) => label(s, e.target)).join(", ") : "no calibrated devices"],
      ];
      if (typeof n.data.fps === "number") rows.push(["Frame rate", <M>{n.data.fps} fps</M>]);
      return { title: `${label(s, n.parent ?? "")} ${n.label}`, rows };
    }
  }
  return null;
}

function edgeFacts(s: FarmState, id: string, now: number): { title: string; rows: Row[] } | null {
  const e = s.edges[id];
  if (!e) return null;
  const src = label(s, e.source);
  const dst = label(s, e.target);
  switch (e.kind) {
    case "lease": {
      const rows: Row[] = [["Holder", src]];
      if (e.data?.token != null) rows.push(["Fencing token", <M>{e.data.token}</M>]);
      if (e.data?.expires_at != null) rows.push(["Time left", <M>{clock(e.data.expires_at - now)}</M>]);
      const rt = s.devices[e.target];
      if (rt?.run) rows.push(["Run", rt.run.state]);
      return { title: `Lease on ${dst}`, rows };
    }
    case "queue":
      return { title: `Waiting for ${dst}`, rows: [["Session", src], ["Position", <M>#{e.data?.position ?? 1}</M>]] };
    case "watches":
      return { title: `Camera watches ${dst}`, rows: [["Verify", s.devices[e.target]?.verifying ? "in progress" : "idle"]] };
    case "attached":
      return { title: `USB: ${src} to ${dst}`, rows: [] };
  }
  return null;
}

export function Tooltip({ state, target, now, bounds }: { state: FarmState; target: HoverTarget; now: number; bounds: { w: number; h: number } }) {
  const facts = target.kind === "node" ? nodeFacts(state, target.id, now) : edgeFacts(state, target.id, now);
  if (!facts) return null;
  // Flip to the other side of the cursor near the right/bottom edges.
  const flipX = target.x > bounds.w - 300;
  const flipY = target.y > bounds.h - 220;
  const style = {
    left: target.x,
    top: target.y,
    transform: `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% - 14px)" : "14px"})`,
  };
  return (
    <div className="map-tip" role="tooltip" style={style}>
      <div className="map-tip__title">{facts.title}</div>
      {facts.rows.length > 0 && (
        <dl className="map-tip__rows">
          {facts.rows.map(([k, v]) => (
            <div key={k} className="map-tip__row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
