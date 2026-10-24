// Right drawer (FRONTEND §5): dispatches on the selected node's kind.
import { useEffect, useState } from "react";
import { useFarm } from "../../state/store";
import type { NodeKind } from "../../state/types";
import { SessionDrawer } from "./SessionDrawer";
import { DeviceDrawer } from "./DeviceDrawer";
import { RigDrawer } from "./RigDrawer";
import { CameraDrawer } from "./CameraDrawer";
import "../panels-shared/panels.css";
import "./Drawer.css";

const KIND_LABEL: Record<NodeKind, string> = { session: "Session", rig: "Rig", device: "Device", camera: "Camera" };

export interface DrawerProps {
  selectedId: string | null;
  onClose: () => void;
  /**
   * Select another node (a leased device, a queued session). Optional so the current App mount keeps working;
   * without it the drawer switches to the clicked node locally (the map highlight then does not follow).
   */
  onSelect?: (id: string) => void;
}

export function Drawer({ selectedId, onClose, onSelect }: DrawerProps) {
  const { state } = useFarm();
  const [localId, setLocalId] = useState<string | null>(null);
  useEffect(() => setLocalId(null), [selectedId]);
  if (!selectedId) return null;

  const id = localId ?? selectedId;
  const select = onSelect ?? setLocalId;
  const node = state.nodes[id];
  const titleId = "drawer-title";

  return (
    <aside className="drawer" aria-labelledby={titleId} data-kind={node?.kind}>
      <header className="drawer-head">
        <div className="drawer-title-wrap">
          <span className="drawer-kind">{node ? KIND_LABEL[node.kind] : "Not found"}</span>
          <h2 id={titleId} className="drawer-title">
            {node?.label ?? id}
          </h2>
        </div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close panel" title="Close panel (Esc)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="drawer-body" key={id}>
        {!node && <p className="pnote">This node is no longer on the map. It may have been removed since you opened it.</p>}
        {node?.kind === "session" && <SessionDrawer node={node} onSelect={select} />}
        {node?.kind === "device" && <DeviceDrawer node={node} onSelect={select} />}
        {node?.kind === "rig" && <RigDrawer node={node} onSelect={select} />}
        {node?.kind === "camera" && <CameraDrawer node={node} onSelect={select} />}
      </div>
    </aside>
  );
}
