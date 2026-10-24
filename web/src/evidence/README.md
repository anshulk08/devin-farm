# Evidence page (CONTRACTS C7)

Public, read-only page for one evidence bundle. Built by Vite as `dist/evidence.html` plus hashed files in `dist/assets/`.

## How control serves it (lane C)

| Request | Serve |
|---|---|
| `GET /e/<evidence_id>` | `web/dist/evidence.html`, with the placeholders below substituted |
| `GET /e/<evidence_id>/<file>` | the bundle file: `evidence.json`, `clip.mp4`, `clip.gif`, `frame-*.jpg` |
| `GET /assets/*` | `web/dist/assets/*` (the page references them by absolute path) |

The page reads the id from `location.pathname` (`/e/<id>`, id matching `[A-Za-z0-9_-]{1,128}`) and fetches `/e/<id>/evidence.json`. A 404 shows "Evidence not found". Missing `clip.mp4` falls back to `clip.gif`, then to a "no clip" note. Missing frames are hidden.

## OpenGraph placeholders in `evidence.html`

Control replaces these literally (HTML-escape the values) before sending the page. They appear in attribute values only.

| Placeholder | Meaning | Example |
|---|---|---|
| `{{OG_TITLE}}` | `og:title`, `twitter:title` | `pico-1 · led_sequence, log_contains · Camera contradicts the claim` |
| `{{OG_DESCRIPTION}}` | `description`, `og:description`, `twitter:description` | `led_sequence on pico.leds: step 2: LED 0 still on (expected only LED 1) Rig rig-1, commit 3c9e1a4.` |
| `{{OG_URL}}` | canonical page URL | `https://<control>.<tailnet>.ts.net/e/<id>` |
| `{{OG_IMAGE}}` | absolute URL of a preview image (≥ 1200×630 ideal) | `https://<control>.<tailnet>.ts.net/e/<id>/frame-1.jpg` |
| `{{OG_IMAGE_ALT}}` | alt text for the image | `Frame recorded by the Farm camera: pico-1 LED bank, step 2` |

Wording must match the page. `ogText(bundle)` in `model.ts` is the reference: title is `<device> · <assertion types> · <verdict title>`, description is `<verdict summary> Rig <rig_id>, commit <short sha>.` Verdict titles:

- `Confirmed by the Farm camera` — every camera check has a measured value and passed (self-reported checks may also be present).
- `Camera contradicts the claim` — at least one camera check measured a value and failed.
- `Not verified: the camera could not measure the device` — a camera check has no measured value (device not visible, uncalibrated, camera down).
- `A self-reported check failed` — no camera failure, but a `log_contains` check failed.
- `Self-reported only, not camera-verified` — no camera checks at all.
- `No checks in this bundle` — empty `results`.

If control does not substitute, crawlers see the raw `{{…}}` text; the page itself still works (it sets `document.title` from the bundle).

## Optional fields the page understands (beyond C7)

- `frames: [{file, t_ms?, caption?}]` — key frames in order. Without it the page tries `frame-1.jpg` … `frame-6.jpg` and hides the ones that 404.
- `sample: true` — marks a fixture or drawing; the page shows a "Sample bundle" notice above the verdict.

## Development

- `npm run dev`, then open `/evidence.html?fixture=1` (demo-fail) or `/evidence.html?fixture=demo-pass`. Fixtures live in `public/fixtures/evidence/<name>/`; their frames are SVG drawings labelled "Sample frame — not camera footage".
- `/evidence.html?id=<id>` loads a real bundle from `/e/<id>/evidence.json` through the dev proxy.
- Pure helpers (verdict classification, formatting, source resolution) are in `model.ts` and tested in `model.test.ts`.
