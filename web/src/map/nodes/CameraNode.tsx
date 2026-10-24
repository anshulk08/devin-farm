import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { CameraData, CloudData } from "../build";
import { CAMERA_D } from "../geometry";
import "./nodes.css";

/** A ±16° wedge, radius r, pointing along +x; rotated per target. */
const R = 120;
const A = (16 * Math.PI) / 180;
const WEDGE = `M0 0 L${R * Math.cos(A)} ${-R * Math.sin(A)} A${R} ${R} 0 0 1 ${R * Math.cos(A)} ${R * Math.sin(A)} Z`;

export const CameraNode = memo(function CameraNode({ id, data }: NodeProps<Node<CameraData, "camera">>) {
  const gid = `scan-${id.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div className={`cam${data.ok ? "" : " cam--down"}${data.scans.length ? " is-scanning" : ""}${data.selected ? " is-selected" : ""}`}>
      <Handle type="source" position={Position.Top} id="out" isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
      {data.scans.length > 0 && (
        <svg className="cam__scan" width="2" height="2" viewBox="-1 -1 2 2" aria-hidden="true" style={{ top: CAMERA_D / 2 }}>
          <defs>
            <radialGradient id={gid} cx="0" cy="0" r={R} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--text)" stopOpacity="0.45" />
              <stop offset="1" stopColor="var(--text)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {data.scans.map((s) => (
            <g key={s.id} transform={`rotate(${s.angle})`}>
              <path className="cam__wedge" d={WEDGE} fill={`url(#${gid})`} />
            </g>
          ))}
        </svg>
      )}
      <div className="cam__lens" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <rect x="2.5" y="6.5" width="19" height="13" rx="3" className="cam__body" />
          <path d="M8 6.5 L9.5 4 H14.5 L16 6.5" className="cam__body" />
          <circle cx="12" cy="13" r="4" className="cam__glass" />
        </svg>
      </div>
      <span className="cam__label mono">{data.label}</span>
    </div>
  );
});

export const CloudNode = memo(function CloudNode({ data }: NodeProps<Node<CloudData, "cloud">>) {
  return (
    <div className="cloud" aria-hidden="true">
      <span className="cloud__label">
        Devin cloud · <span className="mono">{data.count}</span> {data.count === 1 ? "session" : "sessions"}
      </span>
    </div>
  );
});
