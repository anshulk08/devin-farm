// The dashboard: header, sessions, hardware, activity timeline. Desktop and phone layouts share markup;
// CSS switches between card grids (desktop) and stacked rows (phone).
import { useState, type CSSProperties } from "react";
import { useFarm } from "../state/store";
import { useNow } from "../ui/panels-shared/hooks";
import { PUBLIC } from "../data/api";
import { counts, rigCards, sessionRows, type DeviceCard, type RigCard, type SessionRow } from "./model";
import { Avatar, ModePill, Pill } from "./parts";
import { DeviceThumb } from "./DeviceThumb";
import { ActivityTimeline } from "./ActivityTimeline";
import { Check, Chevron, Cross, Dots, DotsV, Plus } from "./Icons";

export type Section = "all" | "sessions" | "hardware";

interface Props {
  section: Section;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onCommand: () => void;
}

export function Dashboard({ section, onSelect, onNewSession, onCommand }: Props) {
  const { state, mode } = useFarm();
  const now = useNow();
  const c = counts(state);
  const sessions = sessionRows(state, now);
  const hw = rigCards(state, now);
  const [tab, setTab] = useState<"sessions" | "hardware">("sessions");

  const jump = (t: "sessions" | "hardware") => {
    setTab(t);
    document.getElementById(`sec-${t}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="dash">
      <header className="dash-head">
        <div className="dash-title-row">
          <h1 className="dash-title">Devin Farm</h1>
          <ModePill />
          <p className="dash-stats">
            <span>
              <b className="mono">{c.sessions}</b> {c.sessions === 1 ? "session" : "sessions"}
            </span>
            <span>
              <b className="mono">{c.active}</b> active
            </span>
            <span>
              <b className="mono">{c.queued}</b> queued
            </span>
          </p>
        </div>
        <div className="dash-actions">
          <button type="button" className="btn-ghost kbd" onClick={onCommand} aria-label="Open command bar">
            <span>⌘</span> K
          </button>
          {!PUBLIC && (
            <>
              <button type="button" className="btn-light" onClick={onNewSession}>
                New session <Plus />
              </button>
              <button type="button" className="btn-icon only-phone" onClick={onNewSession} aria-label="New session">
                <Plus />
              </button>
            </>
          )}
        </div>
      </header>

      {section === "all" && (
        <div className="seg only-phone" role="tablist" aria-label="Jump to section">
          {(["sessions", "hardware"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className="seg-btn" onClick={() => jump(t)}>
              {t === "sessions" ? "Sessions" : "Hardware"}
            </button>
          ))}
        </div>
      )}

      {section !== "hardware" && (
        <section id="sec-sessions" className="dash-sec dash-sessions" aria-labelledby="h-sessions">
          <h2 id="h-sessions" className="sec-title">
            Sessions
          </h2>
          {sessions.length === 0 ? (
            <p className="empty">
              No sessions yet. {PUBLIC ? "" : "Start one with New session; it appears here as soon as Devin picks it up."}
            </p>
          ) : (
            <ul className="srows">
              {sessions.map((r) => (
                <SessionRowView key={r.id} r={r} onSelect={onSelect} />
              ))}
            </ul>
          )}
        </section>
      )}

      {section !== "sessions" && (
        <section id="sec-hardware" className="dash-sec dash-hardware" aria-labelledby="h-hardware">
          <h2 id="h-hardware" className="sec-title">
            Hardware
          </h2>
          {hw.length === 0 ? (
            <p className="empty">No rigs found on the tailnet yet. Rigs appear here when they come online with tag:rig.</p>
          ) : (
            <div className="rigs" style={{ "--cols": hw.map((r) => `${Math.max(1, r.devices.length)}fr`).join(" ") } as CSSProperties}>
              {hw.map((r) => (
                <RigView key={r.id} r={r} live={mode.mode === "live"} onSelect={onSelect} state={state} />
              ))}
            </div>
          )}
        </section>
      )}

      {section === "all" && <ActivityTimeline />}
    </div>
  );
}

function SessionRowView({ r, onSelect }: { r: SessionRow; onSelect: (id: string) => void }) {
  return (
    <li className="srow">
      <button type="button" className="srow-main" onClick={() => onSelect(r.id)} aria-label={`${r.title}, ${r.pill.label}, ${r.meta}`}>
        <Avatar letter={r.letter} hue={r.hue} />
        <span className="srow-text">
          <span className="srow-title">{r.title}</span>
          <span className="srow-id mono">{r.shortId}</span>
          <span className="srow-sub only-phone">
            <Pill pill={r.pill} />
            <span className="mono srow-short">{r.short}</span>
          </span>
        </span>
        <span className="srow-pill only-desk">
          <Pill pill={r.pill} />
        </span>
        <span className="srow-meta mono only-desk">{r.meta}</span>
        <Chevron className="only-phone srow-chev" />
      </button>
      <button type="button" className="srow-more only-desk" onClick={() => onSelect(r.id)} aria-label={`Open ${r.title}`}>
        <Dots />
      </button>
    </li>
  );
}

function RigView({ r, live, onSelect, state }: { r: RigCard; live: boolean; onSelect: (id: string) => void; state: ReturnType<typeof useFarm>["state"] }) {
  const [open, setOpen] = useState(true);
  const dotCls = !r.online ? "off" : r.mock ? "mock" : "on";
  return (
    <article className={`rig${r.online ? "" : " rig-offline"}`} aria-label={`${r.name}${r.mock ? " (mock)" : ""}`}>
      <header className="rig-head">
        <button type="button" className="rig-name" onClick={() => onSelect(r.id)}>
          <span className={`rig-dot ${dotCls}`} aria-hidden />
          <span className="rig-label">{r.name}</span>
          {r.mock && <span className="rig-mock">(mock)</span>}
        </button>
        <span className="rig-health">
          <span>
            <span className="mono">{r.temp}</span> °C
          </span>
          <span>
            load <span className="mono">{r.load}</span>
          </span>
          <span className="rig-cam">
            cam{" "}
            {r.cam === true ? (
              <Check className="ok" aria-label="camera ok" />
            ) : r.cam === false ? (
              <Cross className="bad-cam" aria-label="camera down" />
            ) : (
              <span aria-label="camera unknown">∅</span>
            )}
          </span>
        </span>
        <button type="button" className="rig-more only-desk" onClick={() => onSelect(r.id)} aria-label={`Open ${r.name} details`}>
          <DotsV />
        </button>
        <button type="button" className="rig-toggle only-phone" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? `Collapse ${r.name}` : `Expand ${r.name}`}>
          <Chevron dir={open ? "up" : "down"} />
        </button>
      </header>
      <div className="devs" data-open={open || undefined}>
        {r.devices.length === 0 && <p className="empty">No boards configured on this rig.</p>}
        {r.devices.map((d) => (
          <DeviceView key={d.id} d={d} rigMock={r.mock} live={live} onSelect={onSelect} ticket={d.holder ? state.nodes[d.holder.id]?.label : undefined} />
        ))}
      </div>
    </article>
  );
}

function VerdictChip({ tone }: { tone: NonNullable<DeviceCard["verdict"]> }) {
  const text = { pass: "Camera confirmed", fail: "Camera says no", self: "Self-reported" }[tone];
  return (
    <span className={`vchip vchip-${tone}`} title={text}>
      {tone === "pass" ? <Check /> : tone === "fail" ? <Cross /> : null}
      <span>{tone === "self" ? "self" : tone === "pass" ? "confirmed" : "failed"}</span>
    </span>
  );
}

function DeviceView({ d, rigMock, live, onSelect, ticket }: { d: DeviceCard; rigMock: boolean; live: boolean; onSelect: (id: string) => void; ticket?: string }) {
  const thumb = (size: "card" | "row") => (
    <DeviceThumb id={d.id} board={d.board} offline={d.offline} live={live && !rigMock} art={rigMock ? "wire" : "illustration"} activity={d.holder ? "active" : "idle"} ticket={ticket} size={size} />
  );
  const badge = d.holder ? <Avatar letter={d.holder.letter} hue={d.holder.hue} size="sm" /> : !d.offline && !rigMock ? <span className="dev-dot" aria-hidden /> : null;
  const label = `${d.name}: ${d.pill?.label ?? d.word}${d.holder ? `, held by session ${d.holder.letter}` : ""}, ${d.meta}`;
  return (
    <button type="button" className={`dev${d.offline ? " dev-off" : ""}${d.verifying ? " dev-verifying" : ""}`} onClick={() => onSelect(d.id)} aria-label={label}>
      {/* desktop card */}
      <span className="dev-card only-desk">
        <span className="dev-top">
          <span className="dev-name">{d.name}</span>
          {badge}
        </span>
        <span className="dev-sub">{d.subtitle || " "}</span>
        <span className="dev-thumb">
          {thumb("card")}
          {!d.offline && !rigMock && <span className={`dev-live dot-${d.dot}`} aria-hidden />}
          {d.verdict && <VerdictChip tone={d.verdict} />}
          {d.queue > 0 && <span className="dev-queue mono">{d.queue} waiting</span>}
        </span>
        <span className="dev-foot">
          {d.pill ? <Pill pill={d.pill} /> : <span className="dev-word">{d.word}</span>}
          <span className="dev-meta mono">{d.meta}</span>
        </span>
      </span>
      {/* phone row */}
      <span className="dev-row only-phone">
        {thumb("row")}
        <span className="dev-row-text">
          <span className="dev-top">
            <span className="dev-name">{d.name}</span>
            {rigMock && <span className="rig-mock">(mock)</span>}
            {d.holder && <Avatar letter={d.holder.letter} hue={d.holder.hue} size="sm" />}
            {d.verdict && <VerdictChip tone={d.verdict} />}
          </span>
          <span>{d.pill ? <Pill pill={d.pill} /> : <Pill pill={{ kind: "idle", label: d.word ?? "" }} />}</span>
          <span className="dev-meta mono">{d.meta}</span>
        </span>
        <Chevron className="srow-chev" />
      </span>
    </button>
  );
}
