import { memo, useEffect, useState, type CSSProperties } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { api } from "../../data/api";
import type { DeviceData, BoardType } from "../build";
import { DEVICE_D, DEVICE_W } from "../geometry";
import { useFlash, useSecondTick } from "../hooks";
import { BoardPlaceholder } from "./BoardPlaceholder";
import "./nodes.css";

/** Cropped ROI snapshot refreshed once a second. Double-buffered so the bubble never flashes empty. */
function LiveThumb({ rigId, device, board }: { rigId: string; device: string; board: BoardType }) {
  const t = useSecondTick(true);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = api.snapshotUrl(rigId, device, t);
    const img = new Image();
    img.onload = () => setSrc(url);
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [rigId, device, t]);
  return src ? <img className="dev__img" src={src} alt="" draggable={false} /> : <BoardPlaceholder board={board} />;
}

const VERDICT_GLYPH = { pass: "✓", fail: "✗", self: "self" } as const;

function statusLine(d: DeviceData): string {
  if (d.status === "offline") return "offline";
  if (d.status === "resetting") return "resetting";
  if (d.verifying) return d.holderShort ? `${d.holderShort} · verifying` : "verifying";
  if (d.status === "leased") {
    const run = d.runState && d.runState !== "queued" ? ` · ${d.runState}` : "";
    return d.holderShort ? `held by ${d.holderShort}${run}` : `leased${run}`;
  }
  return "free";
}

const HANDLE = { opacity: 0, pointerEvents: "none" } as const;

export const DeviceNode = memo(function DeviceNode({ data }: NodeProps<Node<DeviceData, "device">>) {
  const flash = useFlash(data.verdictId ?? undefined, data.verdictTone, 1800);
  const style = { "--hue": data.hue ?? "var(--line-strong)" } as CSSProperties;
  const side = (DEVICE_W - DEVICE_D) / 2;
  return (
    <div
      className={`dev dev--${data.status}${data.verifying ? " is-verifying" : ""}${data.selected ? " is-selected" : ""}`}
      style={style}
    >
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={HANDLE} />
      <Handle type="target" position={Position.Left} id="usb" isConnectable={false} style={{ ...HANDLE, left: side, top: DEVICE_D / 2 }} />
      <Handle type="target" position={Position.Bottom} id="cam" isConnectable={false} style={{ ...HANDLE, top: DEVICE_D, bottom: "auto" }} />

      <div className="dev__bubble">
        <div className="dev__face">
          {data.liveThumb ? <LiveThumb rigId={data.rigId} device={data.device} board={data.board} /> : <BoardPlaceholder board={data.board} />}
        </div>
        {data.status === "offline" && <span className="dev__strike" aria-hidden="true" />}
        <span className="dev__ring" aria-hidden="true" />
        {data.verifying && <span className="dev__scan" aria-hidden="true" />}
        {flash && <span key={data.verdictId} className={`dev__flash dev__flash--${flash}`} aria-hidden="true" />}
        {data.verdictTone && (
          <span className={`dev__verdict dev__verdict--${data.verdictTone}`} title="Last verdict">
            {VERDICT_GLYPH[data.verdictTone]}
          </span>
        )}
      </div>

      <div className="dev__label">
        <span className="dev__name mono">{data.label}</span>
        <span className="dev__state">{statusLine(data)}</span>
      </div>
    </div>
  );
});
