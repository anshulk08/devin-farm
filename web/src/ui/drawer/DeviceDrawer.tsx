// Device drawer: live crop, holder/token/expiry/queue, run state + log tail, last verdict, poll, reset, revoke.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFarm } from "../../state/store";
import type { GNode } from "../../state/types";
import { clock, leaseOn, queueOn, sessionHue, splitDeviceId } from "../../state/selectors";
import { api, PUBLIC } from "../../data/api";
import { ConfirmAction } from "../panels-shared/ConfirmAction";
import { VERDICT_LABEL, fmtTime, formatValue, leaseIdOf } from "../panels-shared/format";
import { useAsyncAction, useMutationGate, useNow } from "../panels-shared/hooks";
import { VerdictTable } from "./VerdictTable";

const STATUS_TEXT: Record<string, string> = { free: "Free", leased: "Leased", resetting: "Resetting to idle", offline: "Offline" };
const STATUS_TONE: Record<string, string> = { resetting: "v-warn", offline: "v-off" };
const RUN_TONE: Record<string, string> = { failed: "v-warn", stopped: "v-off" };

export function DeviceDrawer({ node, onSelect }: { node: GNode; onSelect: (id: string) => void }) {
  const { state } = useFarm();
  const now = useNow();
  const gate = useMutationGate();
  const { rigId, device } = splitDeviceId(node.id);
  const lease = leaseOn(state, node.id);
  const queue = queueOn(state, node.id);
  const rt = state.devices[node.id];
  const holder = lease ? state.nodes[lease.source] : undefined;
  const verdict = rt?.lastVerdict;

  return (
    <>
      <section className="dsec">
        <LiveCrop rigId={rigId} device={device} offline={node.status === "offline"} />
        <dl className="facts">
          <dt>Status</dt>
          <dd className={STATUS_TONE[node.status] ?? ""}>
            {STATUS_TEXT[node.status] ?? node.status}
            {typeof node.data.reason === "string" && <span className="pnote">: {node.data.reason}</span>}
          </dd>
          {typeof node.data.type === "string" && (
            <>
              <dt>Board</dt>
              <dd className="mono">{node.data.type}</dd>
            </>
          )}
          <dt>Rig</dt>
          <dd className="mono">{rigId}</dd>
        </dl>
      </section>

      <section className="dsec" aria-labelledby="d-lease">
        <h3 className="dsec-h" id="d-lease">Lease</h3>
        {lease ? (
          <dl className="facts">
            <dt>Holder</dt>
            <dd>
              <button type="button" className="row-btn" onClick={() => onSelect(lease.source)}>
                <span className="row-swatch" style={{ background: sessionHue(lease.source) }} aria-hidden />
                <span className="row-main">{holder?.label ?? lease.source}</span>
              </button>
            </dd>
            <dt>Fencing token</dt>
            <dd className="mono">{lease.data?.token ?? "—"}</dd>
            <dt>Expires in</dt>
            <dd className="mono">{lease.data?.expires_at != null ? clock(lease.data.expires_at - now) : "—"}</dd>
          </dl>
        ) : (
          <p className="empty">No one holds this board.</p>
        )}
        <h3 className="dsec-h">
          Queue
          <span className="pnote mono">{queue.length} waiting</span>
        </h3>
        {queue.length === 0 ? (
          <p className="empty">Nobody is waiting.</p>
        ) : (
          <ol className="rows">
            {queue.map((e) => (
              <li key={e.id}>
                <button type="button" className="row-btn" onClick={() => onSelect(e.source)}>
                  <span className="row-meta">#{e.data?.position ?? "?"}</span>
                  <span className="row-swatch queued" style={{ color: sessionHue(e.source) }} aria-hidden />
                  <span className="row-main">{state.nodes[e.source]?.label ?? e.source}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="dsec" aria-labelledby="d-run">
        <h3 className="dsec-h" id="d-run">
          Run
          {rt?.run && (
            <span className={`pnote ${RUN_TONE[rt.run.state] ?? ""}`}>
              <span className="mono">{rt.run.run_id}</span> · {rt.run.state} · <span className="mono">{fmtTime(rt.run.at)}</span>
            </span>
          )}
        </h3>
        {!rt?.run && <p className="empty">No run on this board yet.</p>}
        {rt && rt.logs.length > 0 && <LogTail logs={rt.logs} />}
      </section>

      <section className="dsec" aria-labelledby="d-verdict">
        <h3 className="dsec-h" id="d-verdict">
          Last verdict
          {verdict && <span className={`chip chip-${verdict.tone}`}>{VERDICT_LABEL[verdict.tone]}</span>}
        </h3>
        {rt?.verifying && (
          <p className="pnote v-warn" role="status">
            Camera is verifying now (since <span className="mono">{fmtTime(rt.verifying.since)}</span>)
          </p>
        )}
        {verdict ? (
          <>
            <p className="pnote">
              Verify <span className="mono">{verdict.verify_id}</span> at <span className="mono">{fmtTime(verdict.at)}</span>
            </p>
            <VerdictTable results={verdict.results} />
            {verdict.evidence_id ? (
              <a className="ext-link" href={`/e/${verdict.evidence_id}`} target="_blank" rel="noreferrer">
                Open the evidence page (clip, frames, results)
              </a>
            ) : (
              <p className="empty">Evidence bundle not published yet.</p>
            )}
          </>
        ) : (
          !rt?.verifying && <p className="empty">This board has not been verified yet.</p>
        )}
      </section>

      <section className="dsec" aria-labelledby="d-actions">
        <h3 className="dsec-h" id="d-actions">Actions</h3>
        <Poll rigId={rigId} device={device} gateReason={PUBLIC ? undefined : gate.reason} />
        {!PUBLIC && (
          <div className="btn-row">
            <ConfirmAction
              label="Reset board"
              question={`Reset ${device}? Rigd reflashes the idle program and the camera must confirm idle before anyone can lease it again.`}
              confirmLabel="Reset board"
              onConfirm={() => api.resetDevice(rigId, device)}
              disabledReason={gate.reason}
              doneText="Reset requested"
            />
            <ConfirmAction
              label="Revoke lease"
              question={`Revoke ${holder?.label ?? "the holder"}'s lease on ${device}? Its fencing token stops working immediately and the next session in the queue gets the board.`}
              confirmLabel="Revoke lease"
              onConfirm={() => (lease ? api.revokeLease(rigId, leaseIdOf(lease.id)) : Promise.reject(new Error("The lease has already ended.")))}
              disabledReason={gate.reason ?? (lease ? undefined : "No lease to revoke")}
              doneText="Lease revoked"
            />
          </div>
        )}
      </section>
    </>
  );
}

/** Live camera crop: ≤ 1 snapshot/s in live mode; a clear placeholder in mock and replay. */
function LiveCrop({ rigId, device, offline }: { rigId: string; device: string; offline: boolean }) {
  const { mode, scrubTs } = useFarm();
  const live = mode.mode === "live" && scrubTs == null;
  const [bust, setBust] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setBust(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  if (!live) {
    return (
      <div className="crop">
        <p className="crop-empty">
          {mode.mode === "live" ? "No live camera while viewing the past." : `No camera in ${mode.mode} mode.`}
          <br />
          The live crop shows here when connected to a rig.
        </p>
      </div>
    );
  }
  return (
    <div className="crop">
      {failed && <p className="crop-empty">{offline ? "Board offline. " : ""}Snapshot unavailable. Retrying every second.</p>}
      <img
        src={api.snapshotUrl(rigId, device, bust)}
        alt={`Camera crop of ${device}`}
        hidden={failed}
        onLoad={() => setFailed(false)}
        onError={() => setFailed(true)}
      />
      {!failed && <span className="crop-badge">camera · 1 fps</span>}
    </div>
  );
}

function LogTail({ logs }: { logs: { ts: number; text: string }[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs]);
  return (
    <pre
      className="logtail"
      ref={ref}
      tabIndex={0}
      aria-label="Run log tail"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {logs.slice(-80).map((l, i) => (
        <div key={i}>
          <span className="log-ts">{fmtTime(l.ts)}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * Poll: fresh health + snapshot (C10). Public builds have no poll route, so there it only refreshes the
 * read-only snapshot. Mock and replay never touch the network.
 */
function Poll({ rigId, device, gateReason }: { rigId: string; device: string; gateReason?: string }) {
  const { mode, scrubTs } = useFarm();
  const pollFn = PUBLIC
    ? async () => ({ state: undefined as unknown, snapshot_url: api.snapshotUrl(rigId, device, Date.now()) })
    : () => api.poll(rigId, device);
  const { state, run } = useAsyncAction(pollFn);
  const reason = PUBLIC ? (mode.mode !== "live" || scrubTs != null ? "Not available outside live view" : undefined) : gateReason;

  return (
    <div className="dsec" style={{ borderBottom: 0, padding: 0 }}>
      <div className="btn-row">
        <button type="button" className="pbtn" disabled={!!reason || state.status === "busy"} title={reason} onClick={() => void run()}>
          {state.status === "busy" ? "Polling…" : PUBLIC ? "Refresh snapshot" : "Poll board"}
        </button>
        {state.status === "error" && <span className="perror" role="alert">{state.error}</span>}
      </div>
      {state.status === "done" && (
        <div className="dsec" style={{ borderBottom: 0, padding: 0 }}>
          <div className="crop">
            <img src={state.value.snapshot_url} alt={`Fresh snapshot of ${device}`} />
            <span className="crop-badge">polled</span>
          </div>
          {state.value.state !== undefined && <pre className="logtail">{formatValue(state.value.state)}</pre>}
        </div>
      )}
    </div>
  );
}
