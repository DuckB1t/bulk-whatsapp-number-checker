# AGENTS.md

Chrome Manifest V3 extension that checks WhatsApp numbers by driving a real `web.whatsapp.com` tab and inspecting its DOM. Pure vanilla JS, zero dependencies.

## No tooling

- No package.json, no build, no tests, no linter, no git repo.
- Nothing to install or run. Verify changes by loading the folder as an unpacked extension in `chrome://extensions` and clicking the popup. The check flow additionally requires the user to be logged into WhatsApp Web (a real tab gets opened/reused).

## Global-namespace scripts (critical)

Files are classic scripts, not ES modules. They share `globalThis`; each file exports via `globalThis.X = X` at the bottom (`StateManager`, `QueueController`, `parseImportContent`, `normalizePhoneNumber`, `COUNTRIES`, `getIcon`, ...).

- **New shared file → register it in BOTH load lists or it will 404 in one context:** the `importScripts(...)` list in `background.js` (line 6) and the `<script>` tags in `popup.html` (bottom of body).
- Files depend on load order (e.g. `normalizer.js` calls `getCountryByCode` from `countries.js`) — keep list order as-is.
- No file is loaded in both the service worker and the popup at once (separate contexts), so duplicate global names are fine; but do not introduce top-level `const`/`let` collisions within a context.

## How a check works (flow)

1. Popup sends `START_JOB` / `CHECK_SINGLE` to the background service worker (`background.js`).
2. Background opens or reuses ONE WhatsApp Web tab (`activeCheckTabId`), navigating to `https://web.whatsapp.com/send/?phone=<digits>&text&type=phone_number&app_absent=0`.
3. `content.js` (content script, runs on all `web.whatsapp.com/*`) inspects the DOM: invalid dialog → `NOT_REGISTERED`; chat input present → `REGISTERED`; QR/login screen → `NOT_LOGGED_IN`; else timeout → `UNKNOWN`.
4. Result returns via `chrome.runtime.sendMessage` (`WHATSAPP_CHECK_RESULT`); background resolves the pending check promise.

- **The DOM selectors in `content.js` (`inspectDom()`, lines ~36–64) are brittle** — WhatsApp changes markup regularly. If checks regress, that file is the first suspect.
- The queue is strictly sequential, one number at a time (single global `activeCheckResolver`).
- Checks reuse an existing open WhatsApp tab; if it's closed, the pending check resolves `UNKNOWN`.

## State & lifecycle

- All job state lives in `chrome.storage.local` under `activeJob` — the single source of truth. The queue re-reads the job from storage every iteration and popup renders from it (also via `JOB_STATE_UPDATED` broadcast).
- MV3 service workers are killed and restarted at Chrome's whim. `initRecovery()` in `background.js` restores a `RUNNING` job on startup/install and demotes a stuck `CHECKING` item back to `PENDING`.
- Job statuses: `IDLE | RUNNING | PAUSED | CANCELLED | COMPLETED`. Number/item statuses: `INVALID | PENDING | CHECKING | REGISTERED | NOT_REGISTERED | UNKNOWN`. Keep these strings consistent everywhere (queue, popup rendering, exporter).

## Conventions

- No emojis anywhere — deliberate; icons are inline SVG from `icons.js` (`getIcon('name')`).
- Settings keys (defaults in `state.js`): `defaultCountry` (`BD`), `checkTimeoutSeconds` (`20`), `interCheckDelayMs` (`1500`), `theme`. Respect them when changing pacing/timeouts.
- `exporter.js` HTML/CSV report generators must stay XSS-safe (`escapeHtml`).
