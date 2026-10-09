# AGENTS.md

Chrome Manifest V3 extension that checks WhatsApp numbers by driving a real `web.whatsapp.com` tab and inspecting its DOM. Pure vanilla JS, zero dependencies.

## No tooling

- No package.json, build, tests, or linter. Nothing to install or run.
- Git repo on branch `main`; no CI or pre-commit hooks.
- Verify changes by loading the folder as an unpacked extension in `chrome://extensions` and clicking the popup. The check flow additionally requires the user to be logged into WhatsApp Web (a real tab gets opened/reused).
- The only executable check is `node mcp/server.js --selftest` (zero-dep; covers the MCP stdio protocol and the extension bridge end to end).

## Global-namespace scripts (critical)

Files are classic scripts, not ES modules. They share `globalThis`; each file exports via `globalThis.X = X` at the bottom (`StateManager`, `QueueController`, `parseImportContent`, `normalizePhoneNumber`, `COUNTRIES`, `getIcon`, ...).

- **The two load lists differ and are the wiring:** `importScripts(...)` in `background.js:6` loads `countries, normalizer, parser, state, queue, mcp-bridge`; the `<script>` tags at the bottom of `popup.html` load `countries, normalizer, parser, state, exporter, icons, popup`. A file used in both contexts must be added to both; a background-only file (`queue.js`, `mcp-bridge.js`) or popup-only file (`exporter.js`, `icons.js`, `popup.js`) goes in its list only.
- Load order matters (`normalizer.js` calls `getCountryByCode` from `countries.js`, `parser.js` calls `normalizePhoneNumber`) — keep list order as-is.
- Shared files (`countries`, `normalizer`, `parser`, `state`) run in both contexts, each with its own global scope, so cross-context reuse is fine; but within one context do not redeclare the same top-level `const`/`let` (e.g. `DEFAULT_SETTINGS` already lives in `state.js`).

## How a check works (flow)

1. Popup sends `START_JOB` / `CHECK_SINGLE` to the background service worker (`background.js`).
2. Background opens or reuses ONE WhatsApp Web tab (`activeCheckTabId`), navigating to `https://web.whatsapp.com/send/?phone=<digits>&text&type=phone_number&app_absent=0`.
3. `content.js` (content script, runs on all `web.whatsapp.com/*`) inspects the DOM: invalid dialog → `NOT_REGISTERED`; chat input present → `REGISTERED`; QR/login screen → `NOT_LOGGED_IN`; else timeout → `UNKNOWN`.
4. Result returns via `chrome.runtime.sendMessage` (`WHATSAPP_CHECK_RESULT`); background resolves the pending check promise.

- **The DOM selectors in `content.js` (`inspectDom()`) are brittle** — WhatsApp changes markup regularly. If checks regress, that file is the first suspect.
- `content.js` only activates on `web.whatsapp.com/send` URLs and self-cancels on `pagehide`/`beforeunload` so a stale inspector cannot emit a duplicate/cross-wired result.
- The queue is strictly sequential, one number at a time (single global `activeCheckResolver`).
- Checks reuse an existing open WhatsApp tab; if it's closed, the pending check resolves `UNKNOWN`.

## State & lifecycle

- All job state lives in `chrome.storage.local` under `activeJob` — the single source of truth. The queue re-reads the job from storage every iteration and popup renders from it (also via `JOB_STATE_UPDATED` broadcast).
- MV3 service workers are killed and restarted at Chrome's whim. `initRecovery()` in `background.js` restores a `RUNNING` job on startup/install and demotes a stuck `CHECKING` item back to `PENDING`.
- Job statuses: `IDLE | RUNNING | PAUSED | CANCELLED | COMPLETED`. Number/item statuses: `INVALID | PENDING | CHECKING | REGISTERED | NOT_REGISTERED | UNKNOWN`. Keep these strings consistent everywhere (queue, popup rendering, exporter).

## MCP bridge (AI agents)

Agents connect to `mcp/server.js` over stdio (MCP protocol `2025-06-18`); that same process runs a localhost HTTP long-poll bridge that the extension service worker polls, so no native-messaging host install is needed.

- `mcp/server.js` — zero-dep Node. stdio MCP on stdout/stdin (newline-delimited JSON-RPC; stdout is reserved for MCP, logs go to stderr) plus `GET /poll`, `POST /result`, `POST /config`, `GET /status` on `127.0.0.1:$BWAV_MCP_PORT`. Tools: `check_whatsapp_number`, `check_whatsapp_numbers`, `bridge_status`. Refuses to start without `BWAV_MCP_TOKEN`; the extension-generated agent config passes port + token via env.
- `mcp-bridge.js` — background-only. Long-polls the server and runs checks through the same `executeWhatsAppCheck` / `activeCheckResolver` single-flight lock as the popup, so MCP and UI checks never overlap. The poll loop keeps the MV3 worker alive; it reconnects on failure.
- Settings keys: `mcpEnabled` (false), `mcpPort` (42811), `mcpToken` (auto-generated on enable), `mcpAllowBulk` (true), `mcpMaxBatch` (50). Changing any of these restarts the bridge via `chrome.storage.onChanged` in `background.js`.
- `manifest.json` `host_permissions` must keep `http://127.0.0.1/*` and `http://localhost/*` or the bridge fetch is blocked.
- The popup Settings > "AI Agent (MCP)" section builds the copy-paste agent config; the extension cannot know its own filesystem path, so it embeds an `<ABSOLUTE_PATH_TO_EXTENSION>` placeholder.

## Conventions

- No emojis anywhere — deliberate; icons are inline SVG from `icons.js` (`getIcon('name')`).
- Settings keys (defaults in `state.js`): `defaultCountry` (`BD`), `checkTimeoutSeconds` (`20`), `interCheckDelayMs` (`1500`), `theme`, plus the MCP keys above. Respect them when changing pacing/timeouts.
- `exporter.js` HTML/CSV report generators must stay XSS-safe (`escapeHtml`).
