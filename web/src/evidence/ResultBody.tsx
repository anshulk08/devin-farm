// Expected-vs-measured body for one C6 result: led_sequence steps, matrix grids, or scalar rows.
import type { AssertionResult } from "../state/types";
import { bankSize, hasMeasured, matrixOf, quantityRows, sequenceRows, toleranceText, uncertaintyFor, type SeqStep } from "./model";

export function ResultBody({ r, camera }: { r: AssertionResult; camera: boolean }) {
  const steps = sequenceRows(r);
  const expGrid = matrixOf(r.expected);
  const meaGrid = matrixOf(r.measured);
  const rows = quantityRows(r);
  const tol = toleranceText(r);
  const measured = hasMeasured(r);

  return (
    <div className="ev-body">
      {!measured && (
        <p className="ev-unmeasured">
          Not measured{camera ? ": the camera has no value for this check, so it cannot pass." : "."}
        </p>
      )}
      {steps && <StepTable r={r} camera={camera} />}
      {(expGrid || meaGrid) && (
        <div className="ev-matrices">
          <Matrix title="Expected" grid={expGrid} />
          <Matrix title="Measured" grid={meaGrid} compare={expGrid} camera={camera} />
        </div>
      )}
      {rows.length > 0 && (
        <div className="ev-table-wrap">
          <table className="ev-table">
            <thead>
              <tr>
                <th scope="col">Quantity</th>
                <th scope="col">Expected</th>
                <th scope="col">Measured</th>
                <th scope="col">Uncertainty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.key}>
                  <th scope="row">{q.label}</th>
                  <td className="mono">{q.expected}</td>
                  <td className="mono">{q.measured}</td>
                  <td className="mono ev-dim">{q.pm ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tol && (
        <p className="ev-tol">
          Tolerance <span className="mono">{tol}</span>
        </p>
      )}
    </div>
  );
}

function StepTable({ r, camera }: { r: AssertionResult; camera: boolean }) {
  const rows = sequenceRows(r) ?? [];
  const n = bankSize(rows);
  const pm = uncertaintyFor("ms", r.uncertainty);
  return (
    <div className="ev-table-wrap">
      <table className="ev-table ev-steps">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Expected LEDs on</th>
            <th scope="col">Measured LEDs on</th>
            <th scope="col">Expected time</th>
            <th scope="col">Measured time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const ledBad = camera && !!s.measured && !s.ledsMatch;
            const timeBad = camera && !!s.measured && Number.isFinite(s.measured.ms) && !s.timeMatch;
            return (
              <tr key={s.index} className={ledBad || timeBad ? "ev-row-bad" : undefined}>
                <th scope="row" className="mono">
                  {s.index}
                </th>
                <td>
                  <Bank step={s.expected} n={n} />
                </td>
                <td className={ledBad ? "ev-cell-bad" : undefined}>
                  <Bank step={s.measured} n={n} expected={camera ? s.expected : null} />
                </td>
                <td className="mono">{s.expected ? `${s.expected.ms} ms` : "—"}</td>
                <td className={`mono${timeBad ? " ev-cell-bad" : ""}`}>
                  {s.measured && Number.isFinite(s.measured.ms) ? (
                    <>
                      {Math.round(s.measured.ms)} ms {pm && <span className="ev-dim">{pm}</span>}
                    </>
                  ) : (
                    "not measured"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A row of LED dots, index 0 first. With `expected`, LEDs that differ get a red ring. */
function Bank({ step, n, expected }: { step: SeqStep | null; n: number; expected?: SeqStep | null }) {
  if (!step) return <span className="mono ev-dim">not measured</span>;
  const on = new Set(step.on);
  const want = expected ? new Set(expected.on) : null;
  return (
    <span className="ev-bank">
      <span className="ev-leds" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className={`ev-led${on.has(i) ? " on" : ""}${want && want.has(i) !== on.has(i) ? " diff" : ""}`}>
            <span className="ev-led-i">{i}</span>
          </span>
        ))}
      </span>
      <span className="mono ev-bank-list">{step.on.length ? `[${step.on.join(", ")}]` : "none"}</span>
    </span>
  );
}

function Matrix({ title, grid, compare, camera }: { title: string; grid: string[] | null; compare?: string[] | null; camera?: boolean }) {
  return (
    <figure className="ev-matrix">
      <figcaption>{title}</figcaption>
      {grid ? (
        <pre className="mono" aria-label={`${title} matrix, ${grid.length} rows`}>
          {grid.map((row, y) => (
            <span key={y} className="ev-matrix-row">
              {[...row].map((c, x) => {
                const diff = camera && compare && compare[y]?.[x] !== undefined && compare[y][x] !== c;
                return (
                  <span key={x} className={`${c === "#" ? "on" : "off"}${diff ? " diff" : ""}`}>
                    {c === "#" ? "■" : "·"}
                  </span>
                );
              })}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <p className="ev-dim">not measured</p>
      )}
    </figure>
  );
}
