/**
 * Manifest V3 Service Worker (Background Process)
 * Coordinates persistent checking queue, WhatsApp Web tab reuse, and state recovery.
 */

importScripts('countries.js', 'normalizer.js', 'parser.js', 'state.js', 'queue.js', 'mcp-bridge.js');

const queue = new QueueController();
let activeCheckTabId = null;
let activeCheckResolver = null;

// Clean up tab reference when closed manually
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeCheckTabId) {
    activeCheckTabId = null;
    if (activeCheckResolver) {
      activeCheckResolver({
        status: 'UNKNOWN',
        notes: 'Checking tab was closed manually'
      });
      activeCheckResolver = null;
    }
  }
});

// Listen for DOM result messages from content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WHATSAPP_CHECK_RESULT') {
    if (activeCheckResolver) {
      activeCheckResolver({
        status: message.status,
        notes: message.notes || ''
      });
      activeCheckResolver = null;
    }
    sendResponse({ acknowledged: true });
  }
  return true;
});

// Verification executor function for single and bulk queue checks
async function executeWhatsAppCheck(item, timeoutMs = DEFAULT_SETTINGS.checkTimeoutSeconds * 1000) {
  const rawNumber = item.normalized || item.original;
  const digitsOnly = rawNumber.replace(/\D/g, '');

  if (!digitsOnly) {
    return { status: 'INVALID', notes: 'No valid phone digits' };
  }

  const targetUrl = `https://web.whatsapp.com/send/?phone=${digitsOnly}&text&type=phone_number&app_absent=0`;

  return new Promise((resolve) => {
    let timer = null;

    const cleanupAndResolve = (result) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      activeCheckResolver = null;
      resolve(result);
    };

    activeCheckResolver = cleanupAndResolve;

    // Timeout guard
    timer = setTimeout(() => {
      cleanupAndResolve({
        status: 'UNKNOWN',
        notes: `Timeout after ${timeoutMs / 1000}s waiting for WhatsApp Web state`
      });
    }, timeoutMs);

    (async () => {
      try {
        // 1. Check if our active check tab reference is still open
        if (activeCheckTabId) {
          try {
            await chrome.tabs.get(activeCheckTabId);
            await chrome.tabs.update(activeCheckTabId, { url: targetUrl, active: true });
          } catch (e) {
            activeCheckTabId = null;
          }
        }

        // 2. If no active check tab, query Chrome for any open web.whatsapp.com tab
        if (!activeCheckTabId) {
          const existingTabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
          if (existingTabs && existingTabs.length > 0) {
            activeCheckTabId = existingTabs[0].id;
            await chrome.tabs.update(activeCheckTabId, { url: targetUrl, active: true });
          } else {
            // 3. Create a new tab ONLY if no WhatsApp Web tab is open anywhere in Chrome
            const tab = await chrome.tabs.create({ url: targetUrl, active: true });
            activeCheckTabId = tab.id;
          }
        }
      } catch (err) {
        cleanupAndResolve({
          status: 'UNKNOWN',
          notes: `Failed to manage WhatsApp Web check tab: ${err.message}`
        });
      }
    })();
  });
}

queue.setCheckExecutor(executeWhatsAppCheck);

// MCP bridge: lets local AI agents (via mcp/server.js) drive checks. Reuses the
// same single-flight resolver as the popup so MCP and UI checks never overlap.
const mcpBridge = new McpBridge();
mcpBridge.configure({
  getSettings: () => StateManager.getSettings(),
  executeCheck: executeWhatsAppCheck,
  isBusy: () => !!activeCheckResolver,
  onStatusChange: (status) => {
    chrome.runtime.sendMessage({ type: 'MCP_STATUS_UPDATED', status }).catch(() => {});
  }
});
mcpBridge.start();

// Handle messages from Popup UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START_JOB') {
      // Abandon any in-flight single check so its result cannot cross-wire into the new job
      if (activeCheckResolver) {
        activeCheckResolver({ status: 'UNKNOWN', notes: 'Superseded by a new bulk job' });
      }
      const parsedData = parseImportContent(message.rawText, message.defaultCountry);
      const newJob = StateManager.createJob(parsedData);
      await StateManager.saveActiveJob(newJob);
      queue.startOrResumeJob();
      sendResponse({ success: true, job: newJob });
    } else if (message.type === 'PAUSE_JOB') {
      await queue.pauseJob();
      sendResponse({ success: true });
    } else if (message.type === 'RESUME_JOB') {
      const job = await StateManager.getActiveJob();
      if (job && job.status === 'PAUSED') {
        job.status = 'RUNNING';
        if (job.pausedAt) {
          job.totalPausedMs = (job.totalPausedMs || 0) + (Date.now() - job.pausedAt);
          job.pausedAt = null;
        }
        await StateManager.saveActiveJob(job);
        queue.startOrResumeJob();
      }
      sendResponse({ success: true });
    } else if (message.type === 'CANCEL_JOB') {
      await queue.cancelJob();
      sendResponse({ success: true });
    } else if (message.type === 'CHECK_SINGLE') {
      // Single check and bulk queue share one tab + one resolver; refuse to run both at once
      if (activeCheckResolver) {
        sendResponse({ success: false, error: 'Check already in progress' });
        return;
      }
      const job = await StateManager.getActiveJob();
      if (job && job.status === 'RUNNING') {
        sendResponse({ success: false, error: 'Bulk job in progress' });
        return;
      }
      const norm = normalizePhoneNumber(message.number, message.country);
      const timeoutMs = DEFAULT_SETTINGS.checkTimeoutSeconds * 1000;
      if (!norm.isValid) {
        // Persist so a popup closed during the check still shows the outcome on reopen
        await StateManager.saveSingleState({
          number: message.number, country: message.country,
          status: 'INVALID', notes: 'Malformed number format',
          normalized: '', timestamp: Date.now(), timeoutMs
        });
        sendResponse({
          success: true,
          result: { status: 'INVALID', notes: 'Malformed number format' }
        });
        return;
      }
      const item = { normalized: norm.normalized, original: message.number };
      // Persist in-flight marker: a popup reopened during the check shows "Checking..."
      await StateManager.saveSingleState({
        number: message.number, country: message.country,
        status: 'CHECKING', notes: '', normalized: norm.normalized,
        timestamp: Date.now(), timeoutMs
      });
      const res = await executeWhatsAppCheck(item, timeoutMs);
      await StateManager.saveSingleState({
        number: message.number, country: message.country,
        status: res.status, notes: res.notes || '',
        normalized: norm.normalized, timestamp: Date.now(), timeoutMs
      });
      sendResponse({ success: true, result: res, normalized: norm.normalized });
    } else if (message.type === 'GET_JOB_STATUS') {
      const job = await StateManager.getActiveJob();
      sendResponse({ success: true, job: job || null });
    } else if (message.type === 'MCP_GET_STATUS') {
      sendResponse({ success: true, status: mcpBridge.getStatus() });
    } else if (message.type === 'CLEAR_JOB') {
      await StateManager.clearActiveJob();
      sendResponse({ success: true });
    }
  })();
  return true;
});

// Restart the MCP bridge only when MCP-relevant settings change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const prev = changes.settings.oldValue || {};
  const next = changes.settings.newValue || {};
  const mcpKeys = ['mcpEnabled', 'mcpPort', 'mcpToken', 'mcpAllowBulk', 'mcpMaxBatch', 'defaultCountry'];
  if (mcpKeys.some((k) => prev[k] !== next[k])) mcpBridge.refresh();
});

// Auto-recovery on service worker startup or extension update
async function initRecovery() {
  const job = await StateManager.getActiveJob();
  if (job && job.status === 'RUNNING') {
    if (job.numbers[job.currentIndex] && job.numbers[job.currentIndex].status === 'CHECKING') {
      job.numbers[job.currentIndex].status = 'PENDING';
      await StateManager.saveActiveJob(job);
    }
    queue.startOrResumeJob();
  }
}

chrome.runtime.onStartup.addListener(initRecovery);
chrome.runtime.onInstalled.addListener(initRecovery);

initRecovery();
