// Public evidence page (CONTRACTS C7). Read-only: no mutating controls, no transcripts.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AssertionResult } from "../state/types";
import {
  classifyResult,
  classifyVerdict,
  commitUrl,
  describeTarget,
  formatDuration,
  formatTimestamp,
  type EvidenceBundle,
  type EvidenceSource,
  type ResultKind,
  type Tone,
  parseBundle,
  repoLabel,
  safeHttpUrl,
  shortSha,
} from "./model";
import { Clip, Frames } from "./Media";
import { ResultBody } from "./ResultBody";
import "./EvidencePage.css";

type Load =
  | { state: "loading" }
  | { state: "ready"; bundle: EvidenceBundle }
  | { state: "error"; title: string; message: string };

export function EvidencePage({ source }: { source: EvidenceSource }) {
  const [load, setLoad] = useState<Load>(() =>
    source.jsonUrl ? { state: "loading" } : { state: "error", title: "No evidence id in this link", message: "Evidence links look like /e/<evidence id>. Check the link you were sent." },
  );

  useEffect(() => {
    if (!source.jsonUrl) return;
    const ctl = new AbortController();
    fetch(source.jsonUrl, { signal: ctl.signal })
      .then(async (r) => {
        if (r.status === 404) throw Object.assign(new Error("notfound"), { notFound: true });
        if (!r.ok) throw new Error(`The server answered ${r.status} ${r.statusText}.`);
        const text = await r.text();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Error("evidence.json is not valid JSON.");
        }
        setLoad({ state: "ready", bundle: parseBundle(raw) });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const notFound = (e as { notFound?: boolean }).notFound;
        setLoad({
          state: "error",
          title: notFound ? "Evidence not found" : "Could not load this evidence",
          message: notFound
            ? `There is no evidence bundle with id ${source.id}. The link may be mistyped, or the bundle was removed from the rig.`
            : e instanceof Error
              ? e.message
              : String(e),
        });
      });
    return () => ctl.abort();
  }, [source.jsonUrl, source.id]);

  if (load.state === "loading")
    return (
      <Shell>
        <p className="ev-status" role="status">
          Loading evidence <span className="mono">{source.id}</span>
        </p>
      </Shell>
    );
  if (load.state === "error")
    return (
      <Shell>
        <section className="ev-status ev-status-error" role="alert">
          <h1>{load.title}</h1>
          <p>{load.message}</p>
        </section>
      </Shell>
    );
  return <Bundle bundle={load.bundle} source={source} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="ev">
      <header className="ev-top">
        <a className="ev-brand" href="/">
          Devin Farm
        </a>
        <span className="ev-top-label">Evidence</span>
      </header>
      <main className="ev-main">{children}</main>
      <Footer />
    </div>
  );
}

const GLYPH: Record<Tone, string> = { ok: "✓", bad: "✗", warn: "!" };

function Bundle({ bundle: b, source }: { bundle: EvidenceBundle; source: EvidenceSource }) {
  const verdict = useMemo(() => classifyVerdict(b.results), [b.results]);
  const sample = b.sample || source.fixture;
  const base = source.baseUrl ?? "";

  useEffect(() => {
    document.title = `${verdict.title} · ${b.device} · Devin Farm evidence`;
  }, [verdict.title, b.device]);

  return (
    <Shell>
      {sample && (
        <p className="ev-sample" role="note">
          Sample bundle for development. The frames are drawings, not camera footage, and this run did not happen on a rig.
        </p>
      )}

      <section className={`ev-verdict tone-${verdict.tone}`} aria-labelledby="ev-verdict-title">
        <span className="ev-verdict-glyph" aria-hidden="true">
          {GLYPH[verdict.tone]}
        </span>
        <div className="ev-verdict-text">
          <h1 id="ev-verdict-title">{verdict.title}</h1>
          <p className="ev-verdict-summary">{verdict.summary}</p>
          <p className="ev-verdict-where">
            <span className="mono">{b.device}</span> on <span className="mono">{b.rig_id}</span>
            <span className="ev-sep" aria-hidden="true">·</span>
            finished <span className="mono">{formatTimestamp(b.finished_at)}</span>
          </p>
        </div>
      </section>

      <div className="ev-grid">
        <section className="ev-media" aria-label="Recording">
          <Clip base={base} />
          <Frames bundle={b} base={base} />
        </section>
        <Meta b={b} />
      </div>

      <section className="ev-results" aria-labelledby="ev-results-title">
        <h2 id="ev-results-title">Expected vs measured</h2>
        {b.results.length === 0 ? (
          <p className="ev-empty">This bundle has no assertion results.</p>
        ) : (
          b.results.map((r, i) => <ResultCard key={i} r={r} />)
        )}
      </section>
    </Shell>
  );
}

const KIND: Record<ResultKind, { label: string; tone: Tone }> = {
  confirmed: { label: "Camera confirmed", tone: "ok" },
  contradicted: { label: "Camera contradicted", tone: "bad" },
  unseen: { label: "Camera could not measure", tone: "warn" },
  self_pass: { label: "Self-reported, passed", tone: "warn" },
  self_fail: { label: "Self-reported, failed", tone: "warn" },
};

function ResultCard({ r }: { r: AssertionResult }) {
  const kind = classifyResult(r);
  const k = KIND[kind];
  return (
    <article className={`ev-result tone-${k.tone}`}>
      <header className="ev-result-head">
        <h3 className="mono">{describeTarget(r)}</h3>
        <span className={`ev-chip tone-${k.tone}`}>
          <span aria-hidden="true">{GLYPH[k.tone]}</span> {k.label}
        </span>
      </header>
      {r.detail && <p className="ev-result-detail">{r.detail}</p>}
      {r.self_reported && <p className="ev-result-note">Read from the run's own log by the rig. The camera did not observe this check.</p>}
      <ResultBody r={r} camera={!r.self_reported} />
    </article>
  );
}

function Meta({ b }: { b: EvidenceBundle }) {
  const repoHref = safeHttpUrl(b.repo_url);
  const commit = commitUrl(b.repo_url, b.sha);
  const temp = Number.isFinite(b.rig.temp_c) ? `${b.rig.temp_c.toFixed(1)} °C` : "unknown";
  return (
    <aside className="ev-meta" aria-label="Run details">
      <h2>Run details</h2>
      <dl>
        <Row k="Repository">
          {b.repo_url ? (
            repoHref ? (
              <a href={repoHref} rel="noopener noreferrer">
                {repoLabel(b.repo_url)}
              </a>
            ) : (
              repoLabel(b.repo_url)
            )
          ) : (
            "unknown"
          )}
        </Row>
        <Row k="Commit">
          {b.sha ? (
            commit ? (
              <a href={commit} rel="noopener noreferrer" title={b.sha}>
                {shortSha(b.sha)}
              </a>
            ) : (
              <span title={b.sha}>{shortSha(b.sha)}</span>
            )
          ) : (
            "unknown"
          )}
        </Row>
        <Row k="Device">{b.device}</Row>
        <Row k="Rig">{b.rig_id}</Row>
        <Row k="Holder">{b.holder || "unknown"}</Row>
        <Row k="Session">{b.farm_id || "unknown"}</Row>
        <Row k="Started">{formatTimestamp(b.started_at)}</Row>
        <Row k="Finished">{formatTimestamp(b.finished_at)}</Row>
        <Row k="Duration">{formatDuration(b.started_at, b.finished_at)}</Row>
        <Row k="Rig temperature">{temp}</Row>
        <Row k="Throttled">
          {b.rig.throttled ? <span className="ev-warn-text">yes, timings may be less precise</span> : "no"}
        </Row>
        <Row k="Verifier">{b.verifier_version || "unknown"}</Row>
        <Row k="Run">{b.run_id || "unknown"}</Row>
        <Row k="Verify">{b.verify_id || "unknown"}</Row>
        <Row k="Evidence">{b.evidence_id}</Row>
      </dl>
    </aside>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="ev-meta-row">
      <dt>{k}</dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}

function Footer() {
  return (
    <footer className="ev-foot">
      <p>
        The Farm camera watches the board from a fixed mount and measures what actually lit up, frame by frame: which LEDs or matrix cells were on,
        for how long, and in what order. A check only counts as confirmed when the camera measured a value and it matched. Checks read from the run's
        own logs are marked self-reported and are never shown as camera-confirmed.
      </p>
      <p>
        <a href="/">Open the live farm map</a>
      </p>
    </footer>
  );
}
