import { memo, type CSSProperties } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { SessionData } from "../build";
import "./nodes.css";

/** Devin status → ring style. Identity is always the session hue (letter + fill); the ring carries status. */
export function sessionRing(status: string): "running" | "waiting" | "finished" | "error" | "joining" | "other" {
  switch (status) {
    case "running":
      return "running";
    case "blocked":
    case "waiting":
    case "suspended":
      return "waiting";
    case "finished":
    case "stopped":
    case "expired":
      return "finished";
    case "error":
    case "failed":
      return "error";
    case "joining":
    case "starting":
      return "joining";
    default:
      return "other";
  }
}

const STATUS_TEXT: Record<string, string> = { blocked: "waiting for you" };

function shortTitle(t: string): string {
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
}

export const SessionNode = memo(function SessionNode({ data }: NodeProps<Node<SessionData, "session">>) {
  const ring = sessionRing(data.status);
  return (
    <div className={`ses ses--${ring}${data.selected ? " is-selected" : ""}`} style={{ "--hue": data.hue } as CSSProperties}>
      <div className="ses__bubble">
        <span className="ses__initial">{data.initial}</span>
        <span className="ses__ring" aria-hidden="true" />
        {data.acus != null && <span className="ses__acu mono">{data.acus.toFixed(1)} ACU</span>}
      </div>
      <div className="ses__title" title={data.title}>
        {shortTitle(data.title)}
      </div>
      <div className="ses__meta">
        <span className="mono">{data.shortId}</span> · {STATUS_TEXT[data.status] ?? data.status}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
    </div>
  );
});
