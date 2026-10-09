/**
 * MCP Bridge Client (background service worker only)
 *
 * Long-polls the local BWAV MCP server (mcp/server.js) over HTTP and executes
 * WhatsApp checks on request, reusing the same single-flight resolver as the
 * popup so MCP and UI checks can never run at once.
 *
 * Loaded only in the service worker (see background.js importScripts).
 * Zero dependencies; relies on global fetch + AbortController.
 */

function mcpSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class McpBridge {
  constructor() {
    this.getSettings = null;
    this.executeCheck = null;
    this.isBusy = null;
    this.onStatusChange = null;
    this.running = false;
    this.connected = false;
    this.message = 'Off';
    this.abortController = null;
    this.generation = 0;
    this.configDirty = true;
  }

  configure(deps) {
    if (deps.getSettings) this.getSettings = deps.getSettings;
    if (deps.executeCheck) this.executeCheck = deps.executeCheck;
    if (deps.isBusy) this.isBusy = deps.isBusy;
    if (deps.onStatusChange) this.onStatusChange = deps.onStatusChange;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.configDirty = true;
    this.generation++;
    this.runLoop(this.generation);
  }

  stop() {
    this.running = false;
    this.generation++;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (e) {
        // ignore
      }
      this.abortController = null;
    }
    this.setConnected(false, 'Off');
  }

  /** Re-read settings and reconnect (used when the popup saves MCP settings). */
  refresh() {
    if (this.running) this.stop();
    this.start();
  }

  getStatus() {
    return { connected: this.connected, running: this.running, message: this.message };
  }

  setConnected(connected, message) {
    const next = message || (connected ? 'Connected' : 'Disconnected');
    if (this.connected === connected && this.message === next) return;
    this.connected = connected;
    this.message = next;
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.getStatus());
    }
  }

  async runLoop(gen) {
    while (this.running && gen === this.generation) {
      let settings;
      try {
        settings = await this.getSettings();
      } catch (e) {
        settings = null;
      }

      if (!settings || !settings.mcpEnabled || !settings.mcpToken) {
        this.setConnected(false, settings && settings.mcpEnabled ? 'No token' : 'Off');
        await mcpSleep(3000);
        continue;
      }

      const port = settings.mcpPort || 42811;
      const authToken = settings.mcpToken;

      try {
        if (this.configDirty) {
          await this.postConfig(port, authToken, settings);
        }

        const controller = new AbortController();
        this.abortController = controller;
        const res = await fetch('http://127.0.0.1:' + port + '/poll?token=' + encodeURIComponent(authToken), {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal
        });
        this.abortController = null;

        if (!this.running || gen !== this.generation) break;

        if (res.status === 204) {
          this.setConnected(true, 'Connected');
          continue;
        }
        if (res.status === 403) {
          this.setConnected(false, 'Bad token');
          await mcpSleep(3000);
          continue;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const job = await res.json();
        this.setConnected(true, 'Connected');
        await this.handleJob(job, settings);
      } catch (e) {
        this.abortController = null;
        if (!this.running || gen !== this.generation) break;
        if (e && e.name === 'AbortError') break;
        this.setConnected(false, 'Disconnected');
        await mcpSleep(3000);
      }
    }
  }

  async postConfig(port, authToken, settings) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/config?token=' + encodeURIComponent(authToken), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          allowBulk: settings.mcpAllowBulk !== false,
          maxBatch: settings.mcpMaxBatch || 50,
          defaultCountry: settings.defaultCountry || 'BD'
        })
      });
      if (res.ok) this.configDirty = false;
    } catch (e) {
      // Server not up yet; retried on the next loop iteration.
    }
  }

  async handleJob(job, settings) {
    if (!job || job.type !== 'check' || !job.id) return;

    let result;
    try {
      if (typeof this.isBusy === 'function' && this.isBusy()) {
        result = { status: 'UNKNOWN', notes: 'Extension is busy with another check' };
      } else {
        const norm = normalizePhoneNumber(job.number, job.country || settings.defaultCountry || 'BD');
        if (!norm.isValid) {
          result = { status: 'INVALID', notes: 'Malformed number format', normalized: '' };
        } else {
          const timeoutSeconds = job.timeoutSeconds || settings.checkTimeoutSeconds || 20;
          const r = await this.executeCheck({ normalized: norm.normalized, original: job.number }, timeoutSeconds * 1000);
          result = { status: r.status, notes: r.notes || '', normalized: norm.normalized };
        }
      }
    } catch (e) {
      result = { status: 'UNKNOWN', notes: e && e.message ? e.message : 'check failed' };
    }

    try {
      await fetch('http://127.0.0.1:' + (settings.mcpPort || 42811) + '/result?token=' + encodeURIComponent(settings.mcpToken), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ id: job.id, result: result })
      });
    } catch (e) {
      // Server went away; the MCP tool call will time out on its side.
    }
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.McpBridge = McpBridge;
}
