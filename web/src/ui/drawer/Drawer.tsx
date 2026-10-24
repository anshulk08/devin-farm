// STUB (lane-d/panels owns src/ui/drawer/**): right drawer for session / device / rig.
import { useFarm } from "../../state/store";

export function Drawer({ selectedId, onClose }: { selectedId: string | null; onClose: () => void }) {
  const { state } = useFarm();
  if (!selectedId) return null;
  const n = state.nodes[selectedId];
  return (
    <aside style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "var(--drawer-w)", background: "var(--panel)" }}>
      <button onClick={onClose}>Close</button>
      <pre>{JSON.stringify(n, null, 2)}</pre>
    </aside>
  );
}
