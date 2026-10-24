// "New session" modal (FRONTEND §5): ticket, optional device hint, extra prompt, ACU cap, remaining budget.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useFarm } from "../state/store";
import { api } from "../data/api";
import { splitDeviceId } from "../state/selectors";
import { fmtNum } from "./panels-shared/format";
import { useFocusTrap, useMutationGate } from "./panels-shared/hooks";
import "./panels-shared/panels.css";
import "./NewSessionModal.css";

interface Ticket {
  id: string;
  title: string;
  device_type: string;
}

/** Used when control has no /api/tickets yet (it is not in C10). */
export const FALLBACK_TICKETS: Ticket[] = [
  { id: "pico/led-sequence", title: "Pico: LED sequence", device_type: "pico" },
  { id: "pico/led-sequence-trap", title: "Pico: LED sequence (trap)", device_type: "pico" },
  { id: "unoq/matrix-heart", title: "Uno Q: matrix heart", device_type: "unoq" },
  { id: "unoq/scroll-devin", title: "Uno Q: scroll DEVIN", device_type: "unoq" },
  { id: "unoq/matrix-trap", title: "Uno Q: matrix (trap)", device_type: "unoq" },
];

const DEFAULT_CAP = 50; // matches the TopBar fallback when /api/budget is unreachable

export function NewSessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <NewSessionDialog onClose={onClose} />;
}

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { live, mode } = useFarm();
  const gate = useMutationGate();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);

  const [tickets, setTickets] = useState<Ticket[]>(FALLBACK_TICKETS);
  const [ticketsNote, setTicketsNote] = useState<string | null>(null);
  const [budget, setBudget] = useState<{ acus_used: number; acus_cap: number } | null>(null);
  const [ticketId, setTicketId] = useState(FALLBACK_TICKETS[0].id);
  const [hint, setHint] = useState("");
  const [extra, setExtra] = useState("");
  const [cap, setCap] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode.mode !== "live") {
      setTicketsNote("Showing the built-in ticket list.");
      return;
    }
    let alive = true;
    api
      .tickets()
      .then((t) => {
        if (!alive || !Array.isArray(t) || t.length === 0) return;
        setTickets(t);
        setTicketId((cur) => (t.some((x) => x.id === cur) ? cur : t[0].id));
      })
      .catch(() => alive && setTicketsNote("Control did not return a ticket list, so these are the built-in tickets."));
    api
      .budget()
      .then((b) => alive && setBudget(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode.mode]);

  const ticket = tickets.find((t) => t.id === ticketId);
  const devices = useMemo(
    () =>
      Object.values(live.nodes)
        .filter((n) => n.kind === "device" && (!ticket || n.data.type === ticket.device_type))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    [live.nodes, ticket],
  );
  useEffect(() => {
    if (hint && !devices.some((d) => d.id === hint)) setHint("");
  }, [devices, hint]);

  const used = budget?.acus_used ?? Object.values(live.nodes).reduce((a, n) => a + (n.kind === "session" ? Number(n.data.acus ?? 0) : 0), 0);
  const total = budget?.acus_cap ?? DEFAULT_CAP;
  const remaining = Math.max(0, total - used);
  const capNum = Number(cap);
  const capValid = Number.isFinite(capNum) && capNum >= 1 && capNum <= 50;
  const overBudget = capValid && capNum > remaining;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!gate.ok || !capValid || !ticket) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSession({
        ticket_id: ticket.id,
        device_hint: hint ? splitDeviceId(hint).device : undefined,
        max_acu: capNum,
        extra_prompt: extra.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="pbackdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nsm" role="dialog" aria-modal="true" aria-labelledby="nsm-title" aria-describedby="nsm-desc" ref={ref}>
        <form onSubmit={submit} noValidate>
          <header className="nsm-head">
            <h2 id="nsm-title">New session</h2>
            <p id="nsm-desc" className="pnote">
              Starts a Devin session on a ticket. It joins the tailnet, queues for a matching board and shows up on the map.
            </p>
          </header>

          <fieldset className="nsm-tickets">
            <legend className="plabel">Ticket</legend>
            {ticketsNote && <p className="pnote nsm-sub">{ticketsNote}</p>}
            {tickets.map((t, i) => (
              <label key={t.id} className="nsm-ticket" data-checked={t.id === ticketId}>
                <input
                  type="radio"
                  name="ticket"
                  value={t.id}
                  checked={t.id === ticketId}
                  onChange={() => setTicketId(t.id)}
                  data-autofocus={i === 0 ? true : undefined}
                />
                <span className="nsm-ticket-title">{t.title}</span>
                <span className="nsm-ticket-id mono">{t.id}</span>
              </label>
            ))}
          </fieldset>

          <div className="nsm-grid">
            <div className="pfield">
              <label className="plabel" htmlFor="nsm-hint">
                Board preference (optional)
              </label>
              <select id="nsm-hint" className="pselect" value={hint} onChange={(e) => setHint(e.target.value)}>
                <option value="">Any {ticket?.device_type ?? ""} board</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id} disabled={d.status === "offline"}>
                    {d.label} on {d.parent?.replace(/^rig:/, "")}
                    {d.status === "offline" ? " (offline)" : d.status === "leased" ? " (leased, will queue)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="pfield">
              <label className="plabel" htmlFor="nsm-cap">
                ACU cap
              </label>
              <div className="nsm-cap">
                <input
                  id="nsm-cap"
                  className="pinput mono"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={50}
                  step={1}
                  value={cap}
                  aria-invalid={!capValid}
                  aria-describedby="nsm-budget"
                  onChange={(e) => setCap(e.target.value)}
                />
                <span className="pnote">ACU</span>
              </div>
            </div>
          </div>
          <p id="nsm-budget" className={`pnote nsm-budget ${overBudget || !capValid ? "v-warn" : ""}`}>
            {!capValid ? (
              "Set a cap between 1 and 50 ACU."
            ) : (
              <>
                <span className="mono">{fmtNum(remaining, 1)}</span> of <span className="mono">{fmtNum(total, 1)}</span> ACU left in the budget
                {budget ? "" : " (estimated from the map)"}
                {overBudget ? ". This cap is more than what is left." : "."}
              </>
            )}
          </p>

          <div className="pfield">
            <label className="plabel" htmlFor="nsm-extra">
              Extra instructions (optional)
            </label>
            <textarea
              id="nsm-extra"
              className="ptextarea"
              rows={3}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Added after the ticket text"
            />
          </div>

          {error && (
            <p className="perror" role="alert">
              Could not create the session: {error}
            </p>
          )}

          <footer className="nsm-foot">
            {gate.reason && <span className="pnote">{gate.reason}. Creating sessions needs a live farm-control.</span>}
            <button type="button" className="pbtn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="pbtn pbtn-strong" disabled={!gate.ok || !capValid || busy} title={gate.reason}>
              {busy ? "Creating…" : "Create session"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
