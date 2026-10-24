// ⌘K command bar: fuzzy jump to any node, poll all boards, start a session, toggle replay.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useFarm } from "../state/store";
import type { NodeKind } from "../state/types";
import { splitDeviceId } from "../state/selectors";
import { api, PUBLIC } from "../data/api";
import { fuzzyScore } from "./panels-shared/format";
import { useFocusTrap, useMutationGate } from "./panels-shared/hooks";
import "./panels-shared/panels.css";
import "./CommandBar.css";

export interface CommandBarProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

interface Item {
  key: string;
  group: "Actions" | "Sessions" | "Rigs" | "Devices" | "Cameras";
  label: string;
  hint?: string;
  search: string;
  disabledReason?: string;
  run: () => void | Promise<void>;
  /** Keep the bar open after running (to show a result). */
  stay?: boolean;
}

const GROUP: Record<NodeKind, Item["group"]> = { session: "Sessions", rig: "Rigs", device: "Devices", camera: "Cameras" };
const GROUP_ORDER: Item["group"][] = ["Actions", "Sessions", "Devices", "Rigs", "Cameras"];

export function CommandBar(props: CommandBarProps) {
  if (!props.open) return null;
  return <CommandDialog {...props} />;
}

function CommandDialog({ onClose, onSelect, onNewSession }: CommandBarProps) {
  const { state, mode } = useFarm();
  const gate = useMutationGate();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  useFocusTrap(ref, true, onClose);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const devices = Object.values(state.nodes).filter((n) => n.kind === "device");
    if (!PUBLIC) {
      out.push({
        key: "poll-all",
        group: "Actions",
        label: "Poll all boards",
        hint: `${devices.length} boards`,
        search: "poll all boards devices refresh health snapshot",
        disabledReason: gate.reason,
        stay: true,
        run: async () => {
          setResult(`Polling ${devices.length} boards…`);
          const res = await Promise.allSettled(
            devices.map((d) => {
              const { rigId, device } = splitDeviceId(d.id);
              return api.poll(rigId, device);
            }),
          );
          const ok = res.filter((r) => r.status === "fulfilled").length;
          setResult(ok === res.length ? `Polled all ${ok} boards.` : `Polled ${ok} of ${res.length} boards. ${res.length - ok} did not answer.`);
        },
      });
      out.push({
        key: "new-session",
        group: "Actions",
        label: "Start a new session",
        search: "new session start create devin ticket",
        run: () => onNewSession(),
      });
    }
    const inReplay = mode.mode === "replay";
    out.push({
      key: "replay",
      group: "Actions",
      label: inReplay ? "Leave replay and go live" : "Play the demo replay",
      hint: inReplay ? undefined : "?replay=demo",
      search: "toggle replay demo live recording",
      run: () => {
        const u = new URL(window.location.href);
        if (inReplay) u.searchParams.delete("replay");
        else {
          u.searchParams.delete("mock");
          u.searchParams.set("replay", "demo");
        }
        window.location.assign(u.toString());
      },
    });
    for (const n of Object.values(state.nodes)) {
      const extra = n.kind === "device" ? n.parent?.replace(/^rig:/, "") : n.kind === "camera" ? `on ${n.parent?.replace(/^rig:/, "")}` : undefined;
      out.push({
        key: n.id,
        group: GROUP[n.kind],
        label: n.kind === "camera" ? `Camera ${n.label}` : n.label,
        hint: [extra, n.status].filter(Boolean).join(" · "),
        search: `${n.kind} ${n.label} ${n.id} ${n.status}`,
        run: () => onSelect(n.id),
      });
    }
    return out;
  }, [state.nodes, mode.mode, gate.reason, onNewSession, onSelect]);

  const shown = useMemo(() => {
    if (!q.trim()) {
      return [...items].sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.label.localeCompare(b.label, undefined, { numeric: true }),
      );
    }
    return items
      .map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.search}`) }))
      .filter((x): x is { it: Item; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it)
      .slice(0, 30);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);
  // The list can shrink under the cursor when nodes leave the map.
  useEffect(() => setActive((a) => Math.max(0, Math.min(a, shown.length - 1))), [shown.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const exec = async (it: Item | undefined) => {
    if (!it || it.disabledReason) return;
    await it.run();
    if (!it.stay) onClose();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      setActive(0);
    } else if (e.key === "End") {
      setActive(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void exec(shown[active]);
    }
  };

  const optId = (i: number) => `cmd-opt-${i}`;
  let lastGroup: string | null = null;

  return (
    <div className="pbackdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Command bar" ref={ref}>
        <input
          className="cmd-input"
          data-autofocus
          role="combobox"
          aria-label="Search nodes and commands"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={shown[active] ? optId(active) : undefined}
          aria-autocomplete="list"
          placeholder="Jump to a session, board or rig, or run a command"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        {result && (
          <p className="cmd-result" role="status">
            {result}
          </p>
        )}
        <ul className="cmd-list" id="cmd-list" role="listbox" ref={listRef} aria-label="Results">
          {shown.length === 0 && <li className="cmd-empty">Nothing matches “{q}”.</li>}
          {shown.map((it, i) => {
            const header = !q.trim() && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.key} role="presentation">
                {header && (
                  <div className="cmd-group" role="presentation">
                    {header}
                  </div>
                )}
                <div
                  id={optId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!!it.disabledReason}
                  className="cmd-opt"
                  title={it.disabledReason}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => void exec(it)}
                >
                  <span className="cmd-label">{it.label}</span>
                  <span className="cmd-hint">{it.disabledReason ?? it.hint}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <footer className="cmd-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to run
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
