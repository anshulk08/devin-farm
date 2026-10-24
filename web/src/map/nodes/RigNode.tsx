import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { RigData } from "../build";
import "./nodes.css";

export const RigNode = memo(function RigNode({ data }: NodeProps<Node<RigData, "rig">>) {
  return (
    <div className={`rig${data.online ? "" : " rig--offline"}${data.selected ? " is-selected" : ""}`} style={{ width: data.w, height: data.h }}>
      <footer className="rig__plate">
        <span key={data.lastSeen ?? 0} className={`rig__beat${data.online ? "" : " rig__beat--off"}`} aria-label={data.online ? "Heartbeat" : "No heartbeat"} />
        <span className="rig__name mono">{data.label}</span>
        {data.model && !data.mock && <span className="rig__model">{data.model}</span>}
        <span className="rig__pills">
          {!data.online && <span className="pill pill--off">offline</span>}
          {data.online && data.tempC != null && <span className={`pill mono${data.throttled ? " pill--warn" : ""}`}>{data.tempC.toFixed(1)} °C</span>}
          {data.online && data.load1 != null && <span className="pill"><span className="pill__k">load</span> <span className="mono">{data.load1.toFixed(2)}</span></span>}
          {data.online && data.cameraOk != null && (
            <span className={`pill${data.cameraOk ? "" : " pill--warn"}`}>cam {data.cameraOk ? "✓" : "down"}</span>
          )}
          {data.throttled && <span className="pill pill--warn">throttled</span>}
          {data.maintenance && <span className="pill pill--warn">maintenance</span>}
          {data.mock && <span className="pill pill--dim" title="This rig runs mock drivers, not real boards">mock</span>}
        </span>
      </footer>
      {data.ports.map((p) => (
        <span key={p.id} className="rig__port" style={{ left: p.x - 5, top: p.y - 5 }} aria-hidden="true">
          <Handle
            type="source"
            position={Position.Right}
            id={`port:${p.id}`}
            isConnectable={false}
            style={{ opacity: 0, pointerEvents: "none", left: 10, top: 5, right: "auto" }}
          />
        </span>
      ))}
    </div>
  );
});
