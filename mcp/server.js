#!/usr/bin/env node
'use strict';

/**
 * BWAV MCP Server (zero dependency)
 *
 * Bridges Model Context Protocol clients (opencode, Claude Desktop, Cursor, ...)
 * to the BWAV Chrome extension over a localhost HTTP long-poll channel.
 *
 * Two faces in one process:
 *   1. MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout
 *      (protocol 2025-06-18; see https://modelcontextprotocol.io).
 *   2. Bridge over HTTP on 127.0.0.1: the extension service worker long-polls
 *      GET /poll, receives one check job, and POSTs the result to /result.
 *
 * stdout is reserved for MCP messages. All logging goes to stderr.
 *
 * Environment:
 *   BWAV_MCP_PORT        default 42811
 *   BWAV_MCP_HOST        default 127.0.0.1
 *   BWAV_MCP_TOKEN       required shared secret (must equal the extension setting)
 *   BWAV_MCP_TIMEOUT_MS  per-number wait, default 60000
 *
 * Run --selftest for a self-contained protocol + bridge check (no extension needed).
 */

const http = require('http');
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_NAME = 'bwav-whatsapp-checker';
const SERVER_VERSION = '1.0.0';

const HOST = process.env.BWAV_MCP_HOST || '127.0.0.1';
let PORT = parseInt(process.env.BWAV_MCP_PORT || '42811', 10);
let TOKEN = process.env.BWAV_MCP_TOKEN || '';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.BWAV_MCP_TIMEOUT_MS || '60000', 10);
const POLL_HOLD_MS = 20000;
const MAX_BODY_BYTES = 1024 * 1024;

function log(...args) {
  process.stderr.write('[bwav-mcp] ' + args.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

let lastPollAt = 0;
const jobQueue = [];
const pendingJobs = new Map(); // id -> { resolve, timer }
let pollWaiters = []; // { res, timer }
let jobSeq = 0;
let extConfig = { allowBulk: true, maxBatch: 50, defaultCountry: 'BD' };

function isBridgeConnected() {
  // A held long-poll means the extension is alive; also allow recent activity
  // (a job being processed means no poll is outstanding for a moment).
  return pollWaiters.length > 0 || (lastPollAt > 0 && Date.now() - lastPollAt < POLL_HOLD_MS + 5000);
}

function enqueueCheck(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!isBridgeConnected() && pollWaiters.length === 0) {
      const err = new Error(
        'BWAV bridge is not connected. Open the BWAV extension popup, go to Settings, turn ON the AI Agent (MCP) bridge, and keep Chrome open with WhatsApp Web logged in.'
      );
      err.kind = 'bridge_off';
      reject(err);
      return;
    }

    const id = 'job_' + ++jobSeq + '_' + Date.now();
    const timer = setTimeout(() => {
      pendingJobs.delete(id);
      const err = new Error(
        'Timed out waiting for the extension to check ' + payload.number + '. Confirm WhatsApp Web is logged in.'
      );
      err.kind = 'timeout';
      reject(err);
    }, timeoutMs);

    pendingJobs.set(id, { resolve, timer });

    const job = Object.assign({ id, type: 'check' }, payload);
    const waiter = pollWaiters.shift();
    if (waiter) deliverJob(waiter, job);
    else jobQueue.push(job);
  });
}

function deliverJob(waiter, job) {
  clearTimeout(waiter.timer);
  pollWaiters = pollWaiters.filter((w) => w !== waiter);
  respondJson(waiter.res, 200, job);
}

function respondJson(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// HTTP bridge (consumed by the extension)
// ---------------------------------------------------------------------------

function handlePoll(req, res) {
  lastPollAt = Date.now();

  const queued = jobQueue.shift();
  if (queued) {
    respondJson(res, 200, queued);
    return;
  }

  const waiter = { res, timer: null };
  waiter.timer = setTimeout(() => {
    pollWaiters = pollWaiters.filter((w) => w !== waiter);
    if (!res.writableEnded) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end();
    }
  }, POLL_HOLD_MS);

  pollWaiters.push(waiter);
  req.on('close', () => {
    clearTimeout(waiter.timer);
    pollWaiters = pollWaiters.filter((w) => w !== waiter);
  });
}

function handleResult(res, body) {
  lastPollAt = Date.now();
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    respondJson(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  const entry = pendingJobs.get(msg.id);
  if (entry) {
    clearTimeout(entry.timer);
    pendingJobs.delete(msg.id);
    entry.resolve(msg.result || { status: 'UNKNOWN', notes: 'empty result' });
  }
  respondJson(res, 200, { ok: true });
}

function handleConfig(res, body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    respondJson(res, 400, { ok: false, error: 'invalid json' });
    return;
  }
  extConfig = {
    allowBulk: msg.allowBulk !== false,
    maxBatch: Number(msg.maxBatch) > 0 ? Number(msg.maxBatch) : 50,
    defaultCountry: msg.defaultCountry || 'BD'
  };
  respondJson(res, 200, { ok: true });
}

function handleStatus(res) {
  respondJson(res, 200, {
    connected: isBridgeConnected(),
    pendingJobs: pendingJobs.size,
    queuedJobs: jobQueue.length,
    pollersWaiting: pollWaiters.length,
    lastPollAgoMs: lastPollAt ? Date.now() - lastPollAt : null,
    allowBulk: extConfig.allowBulk,
    maxBatch: extConfig.maxBatch
  });
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

function startHttpServer(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://' + HOST);
    } catch (e) {
      respondJson(res, 400, { error: 'bad url' });
      return;
    }

    if (url.searchParams.get('token') !== TOKEN) {
      respondJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      handlePoll(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      handleStatus(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/result') {
      readBody(req, (body) => handleResult(res, body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      readBody(req, (body) => handleConfig(res, body));
      return;
    }

    respondJson(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => log('HTTP server error: ' + err.message));
  server.listen(port, HOST, () => log('bridge listening on http://' + HOST + ':' + (port || server.address().port)));
  return server;
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'check_whatsapp_number',
    title: 'Check WhatsApp Number',
    description:
      'Check whether one phone number is registered on WhatsApp. Drives a logged-in WhatsApp Web tab through the local BWAV extension. Returns one of REGISTERED, NOT_REGISTERED, INVALID, UNKNOWN.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'Phone number in local or international format, e.g. "01712345678" or "+8801712345678".'
        },
        country: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code used for numbers without an international prefix (e.g. "BD", "US"). Defaults to the extension setting.'
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Seconds to wait for one check. Default 60.'
        }
      },
      required: ['number']
    }
  },
  {
    name: 'check_whatsapp_numbers',
    title: 'Check Multiple WhatsApp Numbers',
    description:
      'Check a list of phone numbers one at a time through the BWAV extension. Returns per-number results plus a summary count.',
    inputSchema: {
      type: 'object',
      properties: {
        numbers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Phone numbers to check.'
        },
        country: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code for numbers without an international prefix.'
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-number timeout in seconds. Default 60.'
        }
      },
      required: ['numbers']
    }
  },
  {
    name: 'bridge_status',
    title: 'BWAV Bridge Status',
    description: 'Report whether the BWAV extension bridge is connected and able to accept WhatsApp checks.',
    inputSchema: { type: 'object', properties: {} }
  }
];

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeTimeout(sec) {
  const s = Number(sec);
  if (Number.isFinite(s) && s > 0) return Math.min(Math.max(s, 5), 300) * 1000;
  return DEFAULT_TIMEOUT_MS;
}

function textResult(text) {
  return { content: [{ type: 'text', text: text }], isError: false };
}

async function callTool(name, args) {
  if (name === 'bridge_status') {
    const status = {
      connected: isBridgeConnected(),
      pendingJobs: pendingJobs.size,
      queuedJobs: jobQueue.length,
      pollersWaiting: pollWaiters.length,
      lastPollAgoMs: lastPollAt ? Date.now() - lastPollAt : null
    };
    return textResult(JSON.stringify(status, null, 2));
  }

  if (name === 'check_whatsapp_number') {
    if (!args || typeof args.number !== 'string' || !args.number.trim()) {
      throw new ProtocolError(-32602, 'number is required');
    }
    const r = await enqueueCheck({ number: args.number.trim(), country: args.country || null }, normalizeTimeout(args.timeoutSeconds));
    return textResult(
      JSON.stringify(
        { number: args.number.trim(), normalized: r.normalized || null, status: r.status, notes: r.notes || '' },
        null,
        2
      )
    );
  }

  if (name === 'check_whatsapp_numbers') {
    if (!args || !Array.isArray(args.numbers) || args.numbers.length === 0) {
      throw new ProtocolError(-32602, 'numbers must be a non-empty array');
    }
    if (!extConfig.allowBulk) {
      throw new ProtocolError(-32602, 'Bulk checks are disabled in the BWAV extension settings.');
    }
    if (args.numbers.length > extConfig.maxBatch) {
      throw new ProtocolError(
        -32602,
        'Requested ' + args.numbers.length + ' numbers but the extension max per request is ' + extConfig.maxBatch + '.'
      );
    }
    const timeoutMs = normalizeTimeout(args.timeoutSeconds);
    const results = [];
    let registered = 0;
    let notRegistered = 0;
    let unknown = 0;
    let invalid = 0;

    for (let i = 0; i < args.numbers.length; i++) {
      const raw = String(args.numbers[i]).trim();
      if (!raw) continue;
      try {
        const r = await enqueueCheck({ number: raw, country: args.country || null }, timeoutMs);
        results.push({ number: raw, normalized: r.normalized || null, status: r.status, notes: r.notes || '' });
      } catch (e) {
        if (e.kind === 'bridge_off' && results.length === 0) throw e;
        results.push({ number: raw, normalized: null, status: 'UNKNOWN', notes: e.message });
      }
    }

    for (const r of results) {
      if (r.status === 'REGISTERED') registered++;
      else if (r.status === 'NOT_REGISTERED') notRegistered++;
      else if (r.status === 'INVALID') invalid++;
      else unknown++;
    }

    const summary = { total: results.length, registered: registered, notRegistered: notRegistered, unknown: unknown, invalid: invalid };
    const lines = results.map((r) => r.number + ' -> ' + r.status + (r.normalized ? ' (' + r.normalized + ')' : ''));
    return textResult('Summary: ' + JSON.stringify(summary) + '\n\n' + lines.join('\n'));
  }

  throw new ProtocolError(-32602, 'Unknown tool: ' + name);
}

// ---------------------------------------------------------------------------
// MCP stdio loop
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

function negotiateVersion(requested) {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
  return PROTOCOL_VERSION;
}

function handleToolCall(id, params) {
  if (!params || typeof params.name !== 'string') {
    sendError(id, -32602, 'params.name is required');
    return;
  }
  if (!TOOLS.some((t) => t.name === params.name)) {
    sendError(id, -32602, 'Unknown tool: ' + params.name);
    return;
  }

  Promise.resolve()
    .then(() => callTool(params.name, params.arguments || {}))
    .then((result) => sendResult(id, result))
    .catch((err) => {
      if (err && typeof err.code === 'number') sendError(id, err.code, err.message);
      else {
        sendResult(id, {
          content: [{ type: 'text', text: 'Error: ' + (err && err.message ? err.message : String(err)) }],
          isError: true
        });
      }
    });
}

function handleMcpMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  const params = msg.params;

  if (msg.method === 'initialize') {
    sendResult(id, {
      protocolVersion: negotiateVersion(params && params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: 'BWAV WhatsApp Number Checker', version: SERVER_VERSION },
      instructions:
        'Check WhatsApp registration of phone numbers through the local BWAV browser extension. The BWAV extension must have the AI Agent (MCP) bridge enabled and a logged-in WhatsApp Web tab open.'
    });
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;
  if (msg.method === 'ping') {
    if (isRequest) sendResult(id, {});
    return;
  }
  if (msg.method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    handleToolCall(id, params);
    return;
  }
  if (isRequest) sendError(id, -32601, 'Method not found: ' + msg.method);
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log('dropped invalid JSON from stdin');
      return;
    }
    try {
      handleMcpMessage(msg);
    } catch (e) {
      log('handler error: ' + e.message);
    }
  });
  rl.on('close', shutdown);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let httpServer = null;
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of pendingJobs.values()) clearTimeout(entry.timer);
  pendingJobs.clear();
  for (const w of pollWaiters) clearTimeout(w.timer);
  pollWaiters = [];
  if (httpServer) httpServer.close();
  process.exit(0);
}

function main() {
  if (process.argv.includes('--selftest')) return runSelfTest();
  if (!TOKEN) {
    log('BWAV_MCP_TOKEN is required; refusing to expose an unauthenticated local port.');
    process.exit(1);
  }
  httpServer = startHttpServer(PORT);
  startStdio();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  log('BWAV MCP server ready (protocol ' + PROTOCOL_VERSION + '). Waiting for the extension to poll...');
}

// ---------------------------------------------------------------------------
// Self-test (no extension required): node mcp/server.js --selftest
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

function httpPost(url, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runSelfTest() {
  const assert = require('assert');
  if (!TOKEN) TOKEN = 'selftest-token';
  const guard = setTimeout(() => {
    console.error('SELFTEST FAIL: timed out');
    process.exit(1);
  }, 15000);
  guard.unref();

  const server = startHttpServer(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  try {
    assert.strictEqual(negotiateVersion('2025-06-18'), '2025-06-18', 'echoes supported version');
    assert.strictEqual(negotiateVersion('1999-01-01'), PROTOCOL_VERSION, 'falls back to latest');
    assert.ok(TOOLS.find((t) => t.name === 'check_whatsapp_number'), 'tool registered');
    assert.strictEqual(TOOLS.length, 3, 'three tools');

    lastPollAt = 0;
    const statusRes = await callTool('bridge_status', {});
    assert.match(statusRes.content[0].text, /"connected": false/, 'bridge starts disconnected');

    // Simulate the extension: long-poll, then answer the tool call.
    const pollPromise = httpGet(base + '/poll?token=' + TOKEN);
    await sleep(60);
    const toolPromise = callTool('check_whatsapp_number', { number: '01712345678', country: 'BD' });
    const job = JSON.parse((await pollPromise).body);
    assert.strictEqual(job.type, 'check', 'job is a check');
    assert.strictEqual(job.number, '01712345678', 'job carries number');
    assert.strictEqual(job.country, 'BD', 'job carries country');

    await httpPost(base + '/result?token=' + TOKEN, {
      id: job.id,
      result: { status: 'REGISTERED', notes: 'ok', normalized: '+8801712345678' }
    });
    const toolRes = await toolPromise;
    assert.match(toolRes.content[0].text, /"status": "REGISTERED"/, 'tool returns extension result');
    assert.match(toolRes.content[0].text, /\+8801712345678/, 'tool returns normalized');

    // Bulk: extension-reported config is enforced.
    await httpPost(base + '/config?token=' + TOKEN, { allowBulk: false, maxBatch: 2, defaultCountry: 'BD' });
    let bulkDisabled = null;
    try {
      await callTool('check_whatsapp_numbers', { numbers: ['111', '222'] });
    } catch (e) {
      bulkDisabled = e;
    }
    assert.ok(bulkDisabled && bulkDisabled.code === -32602, 'bulk disabled is rejected');

    await httpPost(base + '/config?token=' + TOKEN, { allowBulk: true, maxBatch: 2, defaultCountry: 'BD' });
    let tooMany = null;
    try {
      await callTool('check_whatsapp_numbers', { numbers: ['111', '222', '333'] });
    } catch (e) {
      tooMany = e;
    }
    assert.ok(tooMany && tooMany.code === -32602, 'maxBatch is enforced');

    // Bulk run: simulate the extension answering each queued job.
    const bulkPromise = callTool('check_whatsapp_numbers', { numbers: ['011', '012'], country: 'BD' });
    for (let i = 0; i < 2; i++) {
      const jr = JSON.parse((await httpGet(base + '/poll?token=' + TOKEN)).body);
      await httpPost(base + '/result?token=' + TOKEN, {
        id: jr.id,
        result: { status: i === 0 ? 'REGISTERED' : 'NOT_REGISTERED', notes: '', normalized: jr.number }
      });
    }
    const bulkRes = await bulkPromise;
    assert.match(bulkRes.content[0].text, /"registered":1/, 'bulk tally registered');
    assert.match(bulkRes.content[0].text, /"notRegistered":1/, 'bulk tally notRegistered');

    const bad = await httpGet(base + '/status?token=wrong');
    assert.strictEqual(bad.statusCode, 403, 'rejects bad token');

    // Unknown tool -> protocol error via handler path.
    const collected = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      collected.push(String(chunk));
      return true;
    };
    handleToolCall(999, { name: 'nope', arguments: {} });
    await sleep(10);
    process.stdout.write = origWrite;
    assert.match(collected.join(''), /"code":-32602/, 'unknown tool is a protocol error');

    clearTimeout(guard);
    console.log('SELFTEST PASS');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('SELFTEST FAIL: ' + (err && err.message));
    server.close();
    process.exit(1);
  }
}

main();
