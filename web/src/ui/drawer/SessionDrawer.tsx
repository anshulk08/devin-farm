// Session drawer: status, leases and queue spots, live messages, prompt box, stop.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useFarm } from "../../state/store";
import type { Message } from "../../state/reducer";
import type { GNode } from "../../state/types";
import { clock, edgesOfSession, sessionHue } from "../../state/selectors";
import { api, PUBLIC } from "../../data/api";
import { ConfirmAction } from "../panels-shared/ConfirmAction";
import { farmIdOf, fmtNum, fmtTime } from "../panels-shared/format";
import { useMutationGate, useNow } from "../panels-shared/hooks";

const STATUS_TONE: Record<string, string> = { blocked: "v-warn", joining: "v-warn", finished: "v-off", error: "v-off" };
const STATUS_TEXT: Record<string, string> = {
  joining: "Joining the tailnet",
  running: "Running",
  blocked: "Waiting for you",
  finished: "Finished",
  error: "Error",
};

export function SessionDrawer({ node, onSelect }: { node: GNode; onSelect: (id: string) => void }) {
  const { state } = useFarm();
  const now = useNow();
  const gate = useMutationGate();
  const farmId = String(node.data.farm_id ?? farmIdOf(node.id));
  const { leases, queued } = edgesOfSession(state, node.id);
  const hue = sessionHue(node.id);
  const url = typeof node.data.url === "string" ? node.data.url : null;
  const acus = Number(node.data.acus ?? 0);

  return (
    <>
      <section className="dsec">
        <dl className="facts">
          <dt>Devin status</dt>
          <dd className={STATUS_TONE[node.status] ?? ""}>
            <span className="status-dot" style={node.status === "running" ? { color: hue } : undefined} aria-hidden />
            {STATUS_TEXT[node.status] ?? node.status}
          </dd>
          <dt>ACUs used</dt>
          <dd className="mono">{fmtNum(acus, 1)} ACU</dd>
          {typeof node.data.node_name === "string" && (
            <>
              <dt>Tailnet node</dt>
              <dd className="mono">{node.data.node_name}</dd>
            </>
          )}
        </dl>
        {url && (
          <a className="ext-link" href={url} target="_blank" rel="noreferrer">
            Open the Devin session in a new tab
          </a>
        )}
      </section>

      <section className="dsec" aria-labelledby="s-leases">
        <h3 className="dsec-h" id="s-leases">Boards</h3>
        {leases.length + queued.length === 0 && <p className="empty">Not holding or waiting for any board.</p>}
        <ul className="rows">
          {leases.map((e) => (
            <li key={e.id}>
              <button type="button" className="row-btn" onClick={() => onSelect(e.target)}>
                <span className="row-swatch" style={{ background: hue }} aria-hidden />
                <span className="row-main">
                  Holds {state.nodes[e.target]?.label ?? e.target}
                </span>
                <span className="row-meta">
                  tok {e.data?.token ?? "—"}
                  {e.data?.expires_at != null && ` · ${clock(e.data.expires_at - now)}`}
                </span>
              </button>
            </li>
          ))}
          {queued.map((e) => (
            <li key={e.id}>
              <button type="button" className="row-btn" onClick={() => onSelect(e.target)}>
                <span className="row-swatch queued" style={{ color: hue }} aria-hidden />
                <span className="row-main">Waiting for {state.nodes[e.target]?.label ?? e.target}</span>
                <span className="row-meta">#{e.data?.position ?? "?"} in queue</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {!PUBLIC && <Messages sessionId={node.id} farmId={farmId} />}

      {!PUBLIC && (
        <section className="dsec">
          <div className="btn-row">
            <ConfirmAction
              label="Stop session"
              question="Stop this session? Devin archives it, its leases on every rig are revoked and its tailnet node is deleted. This cannot be undone."
              confirmLabel="Stop session"
              onConfirm={() => api.stopSession(farmId)}
              disabledReason={gate.reason}
              doneText="Stop requested"
            />
          </div>
        </section>
      )}
    </>
  );
}

interface Pending {
  key: number;
  text: string;
  at: number;
  status: "sending" | "sent" | "failed";
  error?: string;
}

function Messages({ sessionId, farmId }: { sessionId: string; farmId: string }) {
  const { state, mode } = useFarm();
  const gate = useMutationGate();
  const [fetched, setFetched] = useState<Message[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const keyRef = useRef(0);

  // Fetch the backlog once on open (live only); SSE session_message events keep it current after that.
  useEffect(() => {
    if (mode.mode !== "live") return;
    let alive = true;
    api
      .messages(farmId)
      .then((m) => alive && setFetched(m))
      .catch((e: unknown) => alive && setFetchErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [farmId, mode.mode]);

  const merged = useMemo(() => {
    const seen = new Set<string>();
    const all = [...fetched, ...(state.messages[sessionId] ?? [])]
      .filter((m) => {
        const k = `${m.ts}|${m.source}|${m.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.ts - b.ts);
    return all.slice(-20);
  }, [fetched, state.messages, sessionId]);

  // Drop an optimistic echo once the real user message shows up.
  const echoes = pending.filter((p) => !(p.status === "sent" && merged.some((m) => m.source === "user" && m.text === p.text && m.ts >= p.at - 30)));

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [merged.length, echoes.length]);

  const send = async (text: string, retryKey?: number) => {
    const key = retryKey ?? ++keyRef.current;
    const at = Date.now() / 1000;
    setPending((p) => [...p.filter((x) => x.key !== key), { key, text, at, status: "sending" }]);
    try {
      await api.sendMessage(farmId, text);
      setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "sent" } : x)));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "failed", error } : x)));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const text = draft.trim();
    if (!text || !gate.ok) return;
    setDraft("");
    void send(text);
  };

  return (
    <section className="dsec" aria-labelledby="s-msgs">
      <h3 className="dsec-h" id="s-msgs">
        Messages
        <span className="pnote">last 20</span>
      </h3>
      {fetchErr && <p className="perror">Could not load earlier messages: {fetchErr}</p>}
      {merged.length + echoes.length === 0 ? (
        <p className="empty">No messages yet.</p>
      ) : (
        <ol className="msgs" ref={listRef} aria-live="polite">
          {merged.map((m, i) => (
            <li key={`${m.ts}-${i}`} className={`msg msg-${m.source}`}>
              <div className="msg-meta">
                <span>{m.source === "user" ? "You" : "Devin"}</span>
                <span className="mono">{fmtTime(m.ts)}</span>
              </div>
              <div className="msg-text">{m.text}</div>
            </li>
          ))}
          {echoes.map((p) => (
            <li key={`p-${p.key}`} className={`msg msg-user ${p.status === "failed" ? "msg-failed" : "msg-sending"}`}>
              <div className="msg-meta">
                <span>You</span>
                <span>{p.status === "sending" ? "Sending…" : p.status === "sent" ? "Sent" : "Not sent"}</span>
              </div>
              <div className="msg-text">{p.text}</div>
              {p.status === "failed" && (
                <div className="btn-row" style={{ marginTop: 6 }}>
                  <span className="perror" style={{ margin: 0 }}>{p.error}</span>
                  <button type="button" className="pbtn" onClick={() => void send(p.text, p.key)}>
                    Retry
                  </button>
                  <button type="button" className="pbtn" onClick={() => setPending((x) => x.filter((y) => y.key !== p.key))}>
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="prompt">
        <label className="plabel" htmlFor="s-prompt">
          Message Devin
        </label>
        <textarea
          id="s-prompt"
          className="ptextarea"
          rows={3}
          value={draft}
          placeholder={gate.ok ? "Tell Devin what to do next" : gate.reason}
          title={gate.reason}
          disabled={!gate.ok}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <span className="prompt-hint">Enter sends, Shift+Enter adds a new line</span>
      </div>
    </section>
  );
}
