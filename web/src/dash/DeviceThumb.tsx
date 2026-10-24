// Device picture: the live cropped camera frame when there is one, otherwise a drawing.
// Drawings are illustrations, not footage (honesty rule); the top bar already says "Mock data".
import { memo, useEffect, useState } from "react";
import { api } from "../data/api";
import type { BoardType } from "../map/build";
import { splitDeviceId } from "../state/selectors";
import "./DeviceThumb.css";

const HEART = [
  ".............",
  "...##...##...",
  "..####.####..",
  "..#########..",
  "...#######...",
  "....#####....",
  ".....###.....",
  "......#......",
];
const IDLE_MATRIX = [
  "#...........#",
  ".............",
  ".............",
  "......#......",
  ".............",
  ".............",
  ".............",
  "#...........#",
];

export type ThumbArt = "illustration" | "wire";

interface Props {
  id: string;
  board: BoardType;
  offline: boolean;
  live: boolean;
  art: ThumbArt;
  /** What the board is doing, for the drawing: lit LEDs / matrix image. */
  activity: "active" | "idle";
  ticket?: string;
  size?: "card" | "row";
}

function useLiveFrame(id: string, on: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    const { rigId, device } = splitDeviceId(id);
    let alive = true;
    const load = () => {
      const url = api.snapshotUrl(rigId, device, Date.now());
      const img = new Image();
      img.onload = () => alive && setSrc(url); // double-buffered: never flashes empty
      img.src = url;
    };
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, on]);
  return on ? src : null;
}

function Matrix({ rows, lit, x0, y0, step, r }: { rows: string[]; lit: boolean; x0: number; y0: number; step: number; r: number }) {
  return (
    <>
      {rows.flatMap((row, y) =>
        [...row].map((c, x) => (
          <circle key={`${x}-${y}`} cx={x0 + x * step} cy={y0 + y * step} r={r} className={c === "#" && lit ? "dt-px on" : c === "#" ? "dt-px dim" : "dt-px"} />
        )),
      )}
    </>
  );
}

function PicoArt({ active, wire }: { active: boolean; wire: boolean }) {
  const pattern = active ? [1, 0, 1, 0, 0] : [1, 0, 0, 0, 0];
  if (wire) {
    return (
      <g className="dt-wire">
        <rect x="18" y="26" width="124" height="54" rx="7" />
        {Array.from({ length: 13 }, (_, i) => (
          <rect key={`t${i}`} x={26 + i * 8.8} y="30" width="5" height="5" rx="1" />
        ))}
        {Array.from({ length: 13 }, (_, i) => (
          <rect key={`b${i}`} x={26 + i * 8.8} y="71" width="5" height="5" rx="1" />
        ))}
        <rect x="10" y="45" width="10" height="16" rx="2" />
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} cx={52 + i * 15} cy="53" r="3.6" className={pattern[i] ? "dt-wire-led on" : "dt-wire-led"} />
        ))}
      </g>
    );
  }
  return (
    <g>
      <rect x="0" y="0" width="160" height="110" className="dt-bench" />
      <path d="M0 92 C40 84 70 98 160 86 L160 110 L0 110 Z" className="dt-bench-2" />
      {/* USB cable */}
      <path d="M8 60 C-10 60 -6 30 -20 24" className="dt-cable" />
      <g transform="rotate(-14 80 52)">
        <rect x="26" y="32" width="108" height="42" rx="3" className="dt-pcb" />
        {Array.from({ length: 20 }, (_, i) => (
          <circle key={`p${i}`} cx={31 + i * 5.2} cy="35.5" r="1.3" className="dt-pad" />
        ))}
        {Array.from({ length: 20 }, (_, i) => (
          <circle key={`q${i}`} cx={31 + i * 5.2} cy="70.5" r="1.3" className="dt-pad" />
        ))}
        <rect x="20" y="45" width="12" height="16" rx="2" className="dt-usb" />
        <rect x="62" y="44" width="18" height="18" rx="1.5" className="dt-chip" />
        <rect x="90" y="46" width="12" height="9" rx="1" className="dt-chip-2" />
        <rect x="40" y="46" width="8" height="5" rx="1" className="dt-btn" />
        <path d="M84 52 H110 M50 60 H62 M104 60 H124" className="dt-trace" />
        <circle cx="38" cy="58" r="2.2" className={active ? "dt-led-on" : "dt-led"} />
      </g>
      {/* external LED bank on the breadboard strip */}
      <rect x="30" y="88" width="100" height="12" rx="2" className="dt-strip" />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          {pattern[i] ? <circle cx={44 + i * 18} cy="94" r="7" className="dt-glow" /> : null}
          <circle cx={44 + i * 18} cy="94" r="3.2" className={pattern[i] ? "dt-led-on" : "dt-led"} />
        </g>
      ))}
    </g>
  );
}

function UnoQArt({ active, heart, wire }: { active: boolean; heart: boolean; wire: boolean }) {
  const rows = heart && active ? HEART : IDLE_MATRIX;
  if (wire) {
    return (
      <g className="dt-wire">
        <rect x="24" y="14" width="112" height="82" rx="8" />
        <Matrix rows={rows} lit x0={44} y0={30} step={6.1} r={1.8} />
      </g>
    );
  }
  return (
    <g>
      <rect x="0" y="0" width="160" height="110" className="dt-bench" />
      <rect x="18" y="8" width="124" height="96" rx="6" className="dt-uno" />
      {Array.from({ length: 14 }, (_, i) => (
        <rect key={i} x={24 + i * 8.3} y="11" width="4.5" height="5" rx="0.8" className="dt-header" />
      ))}
      <rect x="30" y="22" width="100" height="70" rx="3" className="dt-matrix-bg" />
      {rows === HEART ? (
        <g className="dt-matrix-glow">
          <Matrix rows={rows} lit x0={38} y0={30} step={7.1} r={4.2} />
        </g>
      ) : null}
      <Matrix rows={rows} lit x0={38} y0={30} step={7.1} r={2.1} />
    </g>
  );
}

export const DeviceThumb = memo(function DeviceThumb({ id, board, offline, live, art, activity, ticket, size = "card" }: Props) {
  const frame = useLiveFrame(id, live && !offline);
  const cls = `dt dt-${size}`;
  if (offline) {
    return (
      <div className={`${cls} dt-off`} aria-label="Offline: no picture">
        <svg viewBox="0 0 24 24" width={size === "card" ? 38 : 26} height={size === "card" ? 38 : 26} aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.7 5.7l12.6 12.6" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </div>
    );
  }
  if (frame) {
    return (
      <div className={cls}>
        <img src={frame} alt={`Live camera crop of ${id.split("/").pop()}`} />
      </div>
    );
  }
  const wire = art === "wire";
  const active = activity === "active";
  return (
    <div className={`${cls}${wire ? " dt-wireframe" : ""}`} title="Drawing, not camera footage">
      <svg viewBox="0 0 160 110" preserveAspectRatio="xMidYMid slice" aria-hidden>
        {board === "unoq" ? (
          <UnoQArt active={active} heart={/heart/i.test(ticket ?? "")} wire={wire} />
        ) : (
          <PicoArt active={active} wire={wire} />
        )}
      </svg>
    </div>
  );
});
