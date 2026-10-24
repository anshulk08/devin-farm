// Expected-vs-measured table for C6 results. Self-reported rows are amber, never green.
import { Fragment } from "react";
import type { AssertionResult } from "../../state/types";
import { formatUncertainty, formatValue, resultLabel, resultTone } from "../panels-shared/format";

export function VerdictTable({ results }: { results: AssertionResult[] }) {
  if (results.length === 0) return <p className="empty">The verifier returned no results.</p>;
  return (
    <div className="vt-wrap">
      <table className="vt">
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Expected</th>
            <th scope="col">Measured</th>
            <th scope="col">Uncertainty</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <span className="vt-type">{r.type}</span>
                  {r.target && <span className="vt-target">{r.target}</span>}
                </td>
                <td className="mono">{formatValue(r.expected)}</td>
                <td className="mono">{r.self_reported && r.measured === undefined ? "from logs" : formatValue(r.measured)}</td>
                <td className="mono" title={r.uncertainty ? undefined : "No uncertainty reported"}>
                  {formatUncertainty(r.uncertainty)}
                </td>
                <td>
                  <span className={`chip chip-${resultTone(r)}`}>{resultLabel(r)}</span>
                </td>
              </tr>
              {r.detail && (
                <tr className="vt-detail">
                  <td colSpan={5}>{r.detail}</td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
