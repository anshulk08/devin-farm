// Custom edges (FRONTEND §4). Paths are our own cubic so labels/badges can sit at a known point on the curve.
import { createContext, memo, useContext, type CSSProperties } from "react";
import { EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";
import type { AttachedEdgeData, LeaseEdgeData, QueueEdgeData, WatchesEdgeData } from "../build";
import { clock } from "../../state/selectors";
import { useReducedMotion } from "../hooks";
import "./edges.css";

/** Event-time "now" (Unix s) for countdowns, ticking once a second. */
export const ClockContext = createContext(0);

interface Curve {
  d: string;
  at: (t: number) => { x: number; y: number };
}

/** Vertical S-curve from a bottom handle down to a top handle. */
export function verticalCurve(sx: number, sy: number, tx: number, ty: number): Curve {
  const k = Math.max(40, Math.abs(ty - sy) * 0.5);
  const c1 = { x: sx, y: sy + k };
  const c2 = { x: tx, y: ty - k };
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * sx + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * tx,
      y: u * u * u * sy + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * ty,
    };
  };
  return { d: `M${sx},${sy} C${c1.x},${c1.y} ${c2.x},${c2.y} ${tx},${ty}`, at };
}

const labelStyle = (p: { x: number; y: number }): CSSProperties => ({
  transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`,
});

function HitPath({ d }: { d: string }) {
  return <path d={d} className="react-flow__edge-interaction" fill="none" strokeOpacity={0} strokeWidth={22} />;
}

// ---------- lease ----------
export const LeaseEdge = memo(function LeaseEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<LeaseEdgeData, "lease">>) {
  const reduced = useReducedMotion();
  const now = useContext(ClockContext);
  const c = verticalCurve(sourceX, sourceY, targetX, targetY);
  const hue = data?.hue ?? "var(--text)";
  const style = { "--hue": hue } as CSSProperties;

  if (data?.retracting) {
    return (
      <g style={style} className="e-lease e-lease--retract">
        <path d={c.d} pathLength={1} className="e-lease__line" />
      </g>
    );
  }

  const left = data?.expiresAt != null ? data.expiresAt - now : null;
  const label = [data?.token != null ? `tok ${data.token}` : null, left != null ? clock(left) : null].filter(Boolean).join(" · ");
  const lp = c.at(0.5);
  const particles = data?.active && !reduced;

  return (
    <g style={style} className={`e-lease${data?.settled ? "" : " e-lease--enter"}${data?.active ? " is-active" : ""}`}>
      <path d={c.d} className="e-lease__halo" />
      <path d={c.d} pathLength={1} className="e-lease__line" />
      {particles &&
        [0, 1, 2].map((i) => (
          <circle key={i} r={4.5} className="e-lease__particle">
            <animateMotion dur="1.8s" begin={`${-i * 0.6}s`} repeatCount="indefinite" path={c.d} calcMode="linear" />
          </circle>
        ))}
      <HitPath d={c.d} />
      {label && (
        <EdgeLabelRenderer>
          <div className={`e-tag e-tag--lease mono${left != null && left < 30 ? " is-low" : ""}`} style={{ ...labelStyle(lp), ...style }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
});

// ---------- queue ----------
export const QueueEdge = memo(function QueueEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<QueueEdgeData, "queue">>) {
  const c = verticalCurve(sourceX, sourceY, targetX, targetY);
  const style = { "--hue": data?.hue ?? "var(--text)" } as CSSProperties;
  const pos = data?.position ?? 1;
  // Badges near the device end; later positions sit a little further up so they don't stack.
  const bp = c.at(Math.max(0.6, 0.86 - (pos - 1) * 0.08));
  return (
    <g style={style} className={`e-queue${data?.leaving ? " e-queue--leave" : ""}`}>
      <path d={c.d} className="e-queue__line" />
      {!data?.leaving && <HitPath d={c.d} />}
      <EdgeLabelRenderer>
        <div className={`e-badge mono${data?.leaving ? " is-leaving" : ""}`} style={{ ...labelStyle(bp), ...style }}>
          #{pos}
        </div>
      </EdgeLabelRenderer>
    </g>
  );
});

// ---------- watches (camera → device) ----------
export const WatchesEdge = memo(function WatchesEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<WatchesEdgeData, "watches">>) {
  const mx = (sourceX + targetX) / 2;
  const my = Math.max(sourceY, targetY) - Math.abs(targetX - sourceX) * 0.12;
  const d = `M${sourceX},${sourceY} Q${mx},${my} ${targetX},${targetY}`;
  return (
    <g className={`e-watch${data?.active ? " is-active" : ""}${data?.offline ? " is-off" : ""}`}>
      <path d={d} className="e-watch__line" />
      <HitPath d={d} />
    </g>
  );
});

// ---------- attached (rig USB port → device) ----------
export const AttachedEdge = memo(function AttachedEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<AttachedEdgeData, "attached">>) {
  const d = `M${sourceX},${sourceY} L${targetX},${targetY}`;
  return (
    <g className={`e-usb${data?.offline ? " is-off" : ""}`}>
      <path d={d} className="e-usb__line" />
      <HitPath d={d} />
    </g>
  );
});

export const edgeTypes = { lease: LeaseEdge, queue: QueueEdge, watches: WatchesEdge, attached: AttachedEdge };
