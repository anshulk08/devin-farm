// Drawn stand-in for a board when there is no live camera crop (mock / replay / offline).
// Deliberately schematic, never photo-like: nobody should mistake it for camera evidence.
import { memo } from "react";
import type { BoardType } from "../build";

const PICO_LEDS = [22, 36, 50, 64, 78];

function PicoDrawing() {
  return (
    <>
      {/* Pico board: long thin outline with castellated edge marks */}
      <rect x="28" y="22" width="44" height="22" rx="3" className="bp-board" />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1={32 + i * 5} y1="22" x2={32 + i * 5} y2="25" className="bp-pin" />
      ))}
      <rect x="45" y="29" width="10" height="9" rx="1.5" className="bp-chip" />
      {/* the LED bank the camera watches */}
      <line x1="16" y1="64" x2="84" y2="64" className="bp-rail" />
      {PICO_LEDS.map((x) => (
        <circle key={x} cx={x} cy="64" r="4.2" className="bp-led" />
      ))}
    </>
  );
}

function UnoQDrawing() {
  const rows = 8;
  const cols = 13;
  const x0 = 23;
  const y0 = 36;
  const step = 4.5;
  return (
    <>
      <rect x="14" y="24" width="72" height="54" rx="4" className="bp-board" />
      {Array.from({ length: rows * cols }, (_, i) => (
        <circle key={i} cx={x0 + (i % cols) * step} cy={y0 + Math.floor(i / cols) * step} r="1.25" className="bp-px" />
      ))}
    </>
  );
}

function OtherDrawing() {
  return <rect x="24" y="30" width="52" height="40" rx="4" className="bp-board" />;
}

export const BoardPlaceholder = memo(function BoardPlaceholder({ board }: { board: BoardType }) {
  return (
    <svg className="bp" viewBox="0 0 100 100" aria-hidden="true">
      {board === "pico" ? <PicoDrawing /> : board === "unoq" ? <UnoQDrawing /> : <OtherDrawing />}
    </svg>
  );
});
