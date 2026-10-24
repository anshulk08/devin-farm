"""Evidence republishing (C7, C10): copy bundles off the rigs on the `evidence` event and serve them
at /e/<id> on the public port, with an OpenGraph card so PR links preview the verdict."""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import httpx

from .rigs import RigError, RigRegistry
from .store import Store

log = logging.getLogger(__name__)

EVIDENCE_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
EVIDENCE_FILE = re.compile(r"^(evidence\.json|clip\.gif|clip\.mp4|frame-\d{1,3}\.jpg)$")
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FRAMES = 12
CONTENT_TYPES = {".json": "application/json", ".gif": "image/gif", ".mp4": "video/mp4", ".jpg": "image/jpeg"}


def verdict(results: list[dict[str, Any]]) -> str:
    """'confirmed' / 'contradicted' only from camera measurements; self-reported checks never confirm."""
    measured = [r for r in results if not r.get("self_reported")]
    if not measured:
        return "self_reported"
    return "confirmed" if all(r.get("passed") for r in measured) else "contradicted"


class EvidenceStore:
    def __init__(self, root: Path, store: Store, registry: RigRegistry):
        self.root = root
        self._store = store
        self._registry = registry
        self._locks: dict[str, asyncio.Lock] = {}

    def _dir(self, evidence_id: str) -> Path:
        return self.root / evidence_id

    async def ingest(self, rig_id: str, evidence_id: str) -> dict[str, Any] | None:
        if not EVIDENCE_ID.match(evidence_id):
            return None
        self._store.index_evidence(evidence_id, rig_id)
        lock = self._locks.setdefault(evidence_id, asyncio.Lock())
        async with lock:
            cached = self._load(evidence_id)
            if cached is not None:
                return cached
            conn = self._registry.get(rig_id)
            if conn is None:
                return None
            try:
                doc = await conn.client.evidence(evidence_id)
                if doc is None:
                    return None
                self.root.mkdir(parents=True, exist_ok=True)
                tmp = Path(tempfile.mkdtemp(dir=self.root, prefix=".tmp-"))
                try:
                    (tmp / "evidence.json").write_text(json.dumps(doc), encoding="utf-8")
                    names = ["clip.gif", "clip.mp4"] + [f"frame-{i}.jpg" for i in range(MAX_FRAMES)]
                    for name in names:
                        data = await conn.client.evidence_file(evidence_id, name, MAX_FILE_BYTES)
                        if data is None:
                            if name.startswith("frame-"):
                                break
                            continue
                        (tmp / name).write_bytes(data)
                    tmp.rename(self._dir(evidence_id))
                except BaseException:
                    shutil.rmtree(tmp, ignore_errors=True)
                    raise
            except (httpx.HTTPError, RigError, ValueError, OSError) as exc:
                log.warning("evidence %s from %s: %s", evidence_id, rig_id, exc)
                return None
            return doc

    def _load(self, evidence_id: str) -> dict[str, Any] | None:
        path = self._dir(evidence_id) / "evidence.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    async def get(self, evidence_id: str) -> dict[str, Any] | None:
        if not EVIDENCE_ID.match(evidence_id):
            return None
        doc = self._load(evidence_id)
        if doc is not None:
            return doc
        rig_id = self._store.evidence_rig(evidence_id)
        candidates = [rig_id] if rig_id else [c.rig_id for c in self._registry.all() if c.online]
        for rid in candidates:
            doc = await self.ingest(rid, evidence_id)
            if doc is not None:
                return doc
        return None

    def file(self, evidence_id: str, name: str) -> Path | None:
        if not EVIDENCE_ID.match(evidence_id) or not EVIDENCE_FILE.match(name):
            return None
        path = self._dir(evidence_id) / name
        return path if path.is_file() else None

    def files(self, evidence_id: str) -> list[str]:
        d = self._dir(evidence_id)
        return sorted(p.name for p in d.iterdir() if EVIDENCE_FILE.match(p.name)) if d.is_dir() else []


def _fmt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(", ", ": "))
    return str(value)


def _og(evidence_id: str, doc: dict[str, Any], files: list[str], public_url: str) -> dict[str, str]:
    results = doc.get("results") or []
    v = verdict(results)
    label = {"confirmed": "✓ confirmed by camera", "contradicted": "✗ contradicted by camera",
             "self_reported": "self-reported only (not camera-confirmed)"}[v]
    first = results[0] if results else {}
    title = f"{doc.get('device', '')}: {first.get('type', 'verify')} {'✓' if v == 'confirmed' else '✗' if v == 'contradicted' else '·'}"
    desc = f"{label}. rig {doc.get('rig_id', '')}, sha {str(doc.get('sha', ''))[:12]}, {len(results)} assertion(s)."
    base = f"{public_url}/e/{evidence_id}" if public_url else f"/e/{evidence_id}"
    frames = [f for f in files if f.startswith("frame-")]
    image = f"{base}/{frames[0]}" if frames else (f"{base}/clip.gif" if "clip.gif" in files else "")
    return {"title": title, "desc": desc, "base": base, "image": image, "label": label, "verdict": v}


def render_web_page(template: str, evidence_id: str, doc: dict[str, Any], files: list[str], public_url: str) -> str:
    """web/dist/evidence.html (Lane D) with its {{OG_*}} placeholders filled in (web/src/evidence/README.md)."""
    og = _og(evidence_id, doc, files, public_url)
    device = str(doc.get("device", ""))
    subs = {"OG_TITLE": og["title"], "OG_DESCRIPTION": og["desc"], "OG_URL": og["base"], "OG_IMAGE": og["image"],
            "OG_IMAGE_ALT": f"Frame recorded by the Farm camera: {device}"}
    for k, val in subs.items():
        template = template.replace("{{" + k + "}}", html.escape(val, quote=True))
    return template


def render_page(evidence_id: str, doc: dict[str, Any], files: list[str], public_url: str) -> str:
    """Standalone fallback page, used when no web build is present."""
    e = html.escape
    results = doc.get("results") or []
    o = _og(evidence_id, doc, files, public_url)
    v, label, title, desc, base, og_image = o["verdict"], o["label"], o["title"], o["desc"], o["base"], o["image"]
    device = str(doc.get("device", ""))
    frames = [f for f in files if f.startswith("frame-")]

    rows = []
    for r in results:
        if r.get("self_reported"):
            cls, mark = "amber", "self-reported"
        else:
            cls, mark = ("green", "✓ pass") if r.get("passed") else ("red", "✗ fail")
        rows.append("<tr class='{}'><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>"
                    .format(cls, e(mark), e(_fmt(r.get("type"))), e(_fmt(r.get("target"))),
                            e(_fmt(r.get("measured"))), e(_fmt(r.get("expected"))),
                            e(_fmt(r.get("uncertainty"))), e(_fmt(r.get("detail")))))
    media = []
    if "clip.gif" in files:
        media.append(f"<img src='{e(base)}/clip.gif' alt='camera clip'>")
    elif "clip.mp4" in files:
        media.append(f"<video src='{e(base)}/clip.mp4' controls muted loop playsinline></video>")
    media += [f"<img src='{e(base)}/{e(f)}' alt='{e(f)}'>" for f in frames]
    repo, sha = _fmt(doc.get("repo_url")), _fmt(doc.get("sha"))
    meta = [("rig", doc.get("rig_id")), ("device", device), ("session", doc.get("farm_id") or doc.get("holder")),
            ("repo", repo), ("sha", sha), ("run", doc.get("run_id")), ("verify", doc.get("verify_id")),
            ("verifier", doc.get("verifier_version"))]
    meta_html = "".join(f"<dt>{e(k)}</dt><dd>{e(_fmt(val))}</dd>" for k, val in meta if val)
    og = [("og:title", title), ("og:description", desc), ("og:type", "article")]
    if og_image:
        og.append(("og:image", og_image))
    if public_url:
        og.append(("og:url", base))
    og_html = "".join(f"<meta property='{k}' content='{e(val)}'>" for k, val in og)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · Devin Farm evidence</title>{og_html}
<meta name="twitter:card" content="summary_large_image">
<style>
body{{background:#0B0F14;color:#E6EDF3;font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}}
h1{{font-size:22px;margin:0 0 4px}} .v{{font-size:18px;margin:0 0 16px}} .confirmed{{color:#3fb950}}
.contradicted{{color:#f85149}} .self_reported{{color:#d29922}} table{{border-collapse:collapse;width:100%;margin:16px 0}}
td,th{{border-bottom:1px solid #30363d;padding:6px 8px;text-align:left;vertical-align:top;font-family:ui-monospace,monospace;font-size:13px}}
tr.green td:first-child{{color:#3fb950}} tr.red td:first-child{{color:#f85149}} tr.amber td:first-child{{color:#d29922}}
dl{{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;font-family:ui-monospace,monospace;font-size:13px}}
dt{{color:#8b949e}} img,video{{max-width:100%;border-radius:8px;margin:8px 0;display:block}}
footer{{color:#8b949e;font-size:12px;margin-top:24px}}
</style></head><body>
<h1>{e(title)}</h1><p class="v {v}">{e(label)}</p>
<dl>{meta_html}</dl>
<table><thead><tr><th>verdict</th><th>assertion</th><th>target</th><th>measured</th><th>expected</th><th>±</th><th>detail</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
{''.join(media)}
<footer>Recorded by the Farm camera. Self-reported checks (log_contains) are never shown as confirmed.
Raw: <a href="{e(base)}/evidence.json" style="color:#8b949e">evidence.json</a></footer>
</body></html>"""
