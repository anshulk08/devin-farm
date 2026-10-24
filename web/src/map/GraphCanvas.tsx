// STUB (lane-d/map owns src/map/**): the bubble map.
import { useFarm } from "../state/store";

export interface GraphCanvasProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function GraphCanvas({ onSelect }: GraphCanvasProps) {
  const { state } = useFarm();
  return (
    <ul style={{ padding: 32 }}>
      {Object.values(state.nodes).map((n) => (
        <li key={n.id}>
          <button onClick={() => onSelect(n.id)}>{n.id}</button> {n.status}
        </li>
      ))}
    </ul>
  );
}
