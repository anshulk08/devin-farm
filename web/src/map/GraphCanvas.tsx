// The bubble map (FRONTEND §2, §4, §7): React Flow over a pinned band layout.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as RMouseEvent, type KeyboardEvent as RKeyboardEvent, type ReactNode } from "react";
import { ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeTypes, type EdgeTypes } from "@xyflow/react";
import { useFarm } from "../state/store";
import { buildEdges, buildNodes, stabilize, type MapEdge, type MapNode } from "./build";
import { computeLayout, layoutInputFrom, layoutKey, type Layout } from "./layout";
import { SessionNode } from "./nodes/SessionNode";
import { RigNode } from "./nodes/RigNode";
import { DeviceNode } from "./nodes/DeviceNode";
import { CameraNode, CloudNode } from "./nodes/CameraNode";
import { ClockContext, edgeTypes as edgeTypeMap } from "./edges/edges";
import { useEventClock, useReducedMotion } from "./hooks";
import { Tooltip, type HoverTarget } from "./Tooltip";
import "./GraphCanvas.css";

export interface GraphCanvasProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const nodeTypes: NodeTypes = { session: SessionNode, rig: RigNode, device: DeviceNode, camera: CameraNode, cloud: CloudNode } as NodeTypes;
const edgeTypes: EdgeTypes = edgeTypeMap as EdgeTypes;

/** Keeps "nothing important in the outer 5 %": padding is a fraction of the viewport on each side. */
const FIT = { padding: 0.1, maxZoom: 1.25 } as const;
const GHOST_MS = 700;

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  );
}

/** Provides the ticking event clock without re-rendering the whole map every second. */
const Clock = memo(function Clock({ now, paused, children }: { now: number; paused: boolean; children: ReactNode }) {
  const t = useEventClock(now, paused);
  return <ClockContext.Provider value={t}>{children}</ClockContext.Provider>;
});

function MapInner({ selectedId, onSelect }: GraphCanvasProps) {
  const { state, mode, scrubTs } = useFarm();
  const reduced = useReducedMotion();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);

  // ---- layout: recomputed only when the node set changes, seeded from the previous one ----
  const input = useMemo(() => layoutInputFrom(state.nodes), [state.nodes]);
  const key = layoutKey(input);
  const prevLayout = useRef<Layout | undefined>(undefined);
  const layout = useMemo(() => computeLayout(input, prevLayout.current), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    prevLayout.current = layout;
  }, [layout]);

  // ---- nodes ----
  const liveThumbs = mode.mode === "live" && scrubTs == null;
  const prevNodes = useRef(new Map<string, MapNode>());
  const nodes = useMemo(
    () => stabilize(prevNodes.current, buildNodes(state, layout, { liveThumbs, selectedId })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.nodes, state.edges, state.devices, layout, liveThumbs, selectedId],
  );
  useEffect(() => {
    prevNodes.current = new Map(nodes.map((n) => [n.id, n]));
  }, [nodes]);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  // ---- edges ----
  // Leases present on first paint don't "draw in"; later ones do (that is the hand-over moment).
  // A scrub (and the jump back to live when it ends) is a jump, not a hand-over: nothing draws in or retracts.
  const scrubbing = scrubTs != null;
  const lastScrub = useRef(scrubbing);
  const scrubJump = scrubbing || lastScrub.current !== scrubbing;
  useEffect(() => {
    lastScrub.current = scrubbing;
  }, [scrubbing]);
  const settled = useRef<Set<string> | null>(null);
  if (settled.current === null && Object.keys(state.edges).length > 0) {
    settled.current = new Set(Object.keys(state.edges));
  } else if (settled.current && scrubJump) {
    for (const id of Object.keys(state.edges)) settled.current.add(id);
  }
  const prevEdges = useRef(new Map<string, MapEdge>());
  const baseEdges = useMemo(
    () => stabilize(prevEdges.current, buildEdges(state, nodeIds, settled.current ?? new Set())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.edges, state.devices, state.nodes, nodeIds],
  );

  // Ghosts: removed lease lines retract upward, removed queue lines fade, then disappear.
  const [ghosts, setGhosts] = useState<MapEdge[]>([]);
  const ghostTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const prev = prevEdges.current;
    const next = new Map(baseEdges.map((e) => [e.id, e]));
    prevEdges.current = next;
    // No ghosts for reduced motion or while browsing history (a scrub is a jump, not a hand-over).
    if (reduced || scrubJump || prev.size === 0) return;
    const gone: MapEdge[] = [];
    prev.forEach((e, id) => {
      if (next.has(id) || !nodeIds.has(e.source) || !nodeIds.has(e.target)) return;
      if (e.type === "lease") gone.push({ ...e, id: `ghost:${id}`, data: { ...e.data!, retracting: true, active: false } } as MapEdge);
      else if (e.type === "queue") gone.push({ ...e, id: `ghost:${id}`, data: { ...e.data!, leaving: true } } as MapEdge);
    });
    if (gone.length === 0) return;
    const goneIds = new Set(gone.map((g) => g.id));
    setGhosts((g) => [...g.filter((x) => !goneIds.has(x.id)), ...gone]);
    // Not cleared on re-run: other events arriving mid-animation must not strand a ghost.
    const timers = ghostTimers.current;
    const t = setTimeout(() => {
      timers.delete(t);
      setGhosts((g) => g.filter((x) => !goneIds.has(x.id)));
    }, GHOST_MS);
    timers.add(t);
  }, [baseEdges, nodeIds, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timers = ghostTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const edges = useMemo(() => {
    if (ghosts.length === 0) return baseEdges;
    // Ghosts draw under the live lines so a promoted queue line solidifies on top.
    return [...ghosts.map((g) => ({ ...g, selectable: false, focusable: false })), ...baseEdges] as MapEdge[];
  }, [baseEdges, ghosts]);

  // ---- fit view: first load and whenever the node set (or the canvas size) changes ----
  const hasNodes = nodes.length > 1;
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasNodes) return;
    const id = requestAnimationFrame(() => void rf.fitView({ ...FIT, duration: reduced || !prevKeyRef.current ? 0 : 400 }));
    prevKeyRef.current = key;
    return () => cancelAnimationFrame(id);
  }, [key, hasNodes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => void rf.fitView({ ...FIT, duration: reduced ? 0 : 250 }), 120);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [rf, reduced]);

  // ---- interaction ----
  // Hover lives in a tiny external store so mouse moves re-render only the tooltip, never the map.
  const [hoverStore] = useState(createHoverStore);
  const setHover = hoverStore.set;
  const local = useCallback((e: RMouseEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
  }, []);
  const hoverNode = useCallback(
    (e: RMouseEvent, n: Node) => {
      if (n.type === "cloud") return;
      const p = local(e);
      setHover({ kind: "node", id: n.id, x: p.x, y: p.y, w: p.w, h: p.h });
    },
    [local, setHover],
  );
  const hoverEdge = useCallback(
    (e: RMouseEvent, ed: Edge) => {
      if (ed.id.startsWith("ghost:")) return;
      const p = local(e);
      setHover({ kind: "edge", id: ed.id, x: p.x, y: p.y, w: p.w, h: p.h });
    },
    [local, setHover],
  );
  const clearHover = useCallback(() => setHover(null), [setHover]);
  const onNodeClick = useCallback((_: RMouseEvent, n: Node) => n.type !== "cloud" && onSelect(n.id), [onSelect]);
  const onEdgeClick = useCallback(
    (_: RMouseEvent, e: Edge) => {
      if (e.type === "lease" || e.type === "queue") onSelect(e.target);
    },
    [onSelect],
  );
  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);
  // Keyboard: React Flow makes nodes focusable but only fires onNodeClick for the mouse. Enter/Space selects.
  const onKeyDown = useCallback(
    (e: RKeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = (e.target as HTMLElement).closest?.(".react-flow__node");
      const id = el?.getAttribute("data-id");
      if (!id || id === "cloud") return;
      e.preventDefault();
      onSelect(id);
    },
    [onSelect],
  );

  const empty = Object.keys(state.nodes).length === 0;

  return (
    <div className="map" ref={wrapRef} onMouseLeave={clearHover} onKeyDown={onKeyDown}>
      <Clock now={state.now} paused={scrubTs != null}>
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeMouseEnter={hoverNode}
          onNodeMouseMove={hoverNode}
          onNodeMouseLeave={clearHover}
          onEdgeMouseEnter={hoverEdge}
          onEdgeMouseMove={hoverEdge}
          onEdgeMouseLeave={clearHover}
          onMoveStart={clearHover}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          minZoom={0.25}
          maxZoom={2}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        />
        <HoverTip store={hoverStore} />
      </Clock>
      {empty && (
        <div className="map__empty">
          <p>No graph yet.</p>
          <p className="map__empty-sub">Waiting for the first snapshot from farm-control.</p>
        </div>
      )}
    </div>
  );
}

type Hover = (HoverTarget & { w: number; h: number }) | null;

function createHoverStore() {
  let v: Hover = null;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (next: Hover) => {
      if (next === v || (next === null && v === null)) return;
      v = next;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

function HoverTip({ store }: { store: ReturnType<typeof createHoverStore> }) {
  const target = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { state } = useFarm();
  const now = useContext(ClockContext);
  if (!target) return null;
  return <Tooltip state={state} target={target} now={now} bounds={{ w: target.w, h: target.h }} />;
}
