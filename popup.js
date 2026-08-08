/**
 * Popup Interface Controller with Atomic Triple-Sync State Restoration
 * Guarantees zero lost typed numbers, country selections, or check progress across cloned windows.
 */

let activeJobState = null;
let timerInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
  renderIcons();
  await initTheme();
  populateCountrySelectsSync();
  setupNavigation();
  setupSingleMode();
  setupBulkMode();
  setupSettingsMode();
  setupModal();

  // Load state atomically on launch before any paint
  await loadAndRestoreAllState();

  // Subscribe to storage updates from service worker
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.activeJob) {
        activeJobState = changes.activeJob.newValue || null;
        renderBulkState();
      }
      if (changes.singleState) {
        applySingleState(changes.singleState.newValue);
      }
    });
  }
});

// Helper to query active job state from worker memory or storage with await Promise
async function fetchActiveJobFromWorkerOrStorage() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_JOB_STATUS' }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      if (resp && resp.success && resp.job) {
        return resp.job;
      }
    } catch (e) {
      // Ignore background worker sleep error
    }
  }

  return await StateManager.getActiveJob();
}

// Render SVG icons (No emojis!)
function renderIcons() {
  const iconMap = {
    brandIcon: 'globe',
    iconSingle: 'single',
    iconBulk: 'bulk',
    iconSettings: 'settings',
    iconCheckSingle: 'single',
    iconImportTxt: 'fileText',
    iconImportCsv: 'fileCsv',
    iconStartBulk: 'play',
    iconPause: 'pause',
    iconResume: 'play',
    iconCancel: 'stop',
    iconExportHtml: 'download',
    iconExportCsv: 'fileCsv',
    iconNewCheck: 'refresh',
    iconThemeSystem: 'monitor',
    iconThemeLight: 'sun',
    iconThemeDark: 'moon'
  };

  for (const [id, name] of Object.entries(iconMap)) {
    const el = document.getElementById(id);
    if (el && typeof getIcon === 'function') {
      el.innerHTML = getIcon(name);
    }
  }
}

// Theme handling
async function initTheme() {
  const settings = await StateManager.getSettings();
  applyTheme(settings.theme || 'system');
}

function applyTheme(theme) {
  const root = document.documentElement;
  const isDarkSystem = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  let active = theme;
  if (active === 'system') {
    active = isDarkSystem ? 'dark' : 'light';
  }

  if (active === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
}

// Populate Country Selects options synchronously
function populateCountrySelectsSync() {
  const countryList = (typeof COUNTRIES !== 'undefined') ? COUNTRIES : [];
  const singleSel = document.getElementById('singleCountrySelect');
  const bulkSel = document.getElementById('bulkCountrySelect');
  const settingsSel = document.getElementById('settingsDefaultCountry');

  const optionsHtml = countryList.map(c => `<option value="${c.code}">${c.name} (${c.dialCode})</option>`).join('');

  if (singleSel) singleSel.innerHTML = optionsHtml;
  if (bulkSel) bulkSel.innerHTML = optionsHtml;
  if (settingsSel) settingsSel.innerHTML = optionsHtml;
}

// Switch Tab
function switchTab(targetId) {
  const tabs = document.querySelectorAll('.nav-tab');
  const panels = document.querySelectorAll('.view-panel');

  tabs.forEach(t => t.classList.remove('active'));
  panels.forEach(p => p.classList.remove('active'));

  const tabBtn = document.querySelector(`.nav-tab[data-tab="${targetId}"]`);
  const panel = document.getElementById(`view${targetId.charAt(0).toUpperCase() + targetId.slice(1)}`);

  if (tabBtn && panel) {
    tabBtn.classList.add('active');
    panel.classList.add('active');
  }
}

// Navigation Event Setup
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      const targetId = tab.getAttribute('data-tab');
      switchTab(targetId);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ activeTab: targetId });
      }
    });
  });
}

// Single Mode logic with real-time field auto-save
function setupSingleMode() {
  const btn = document.getElementById('btnCheckSingle');
  const input = document.getElementById('singlePhoneInput');
  const countrySel = document.getElementById('singleCountrySelect');

  const saveSingleDraft = () => {
    if (input && countrySel) {
      StateManager.saveSingleDraft(input.value, countrySel.value);
    }
  };

  if (input) input.addEventListener('input', saveSingleDraft);
  if (countrySel) countrySel.addEventListener('change', saveSingleDraft);

  btn.addEventListener('click', async () => {
    const rawVal = input.value.trim();
    if (!rawVal) {
      showAlert({
        title: 'Phone Number Required',
        message: 'Please enter a phone number',
        icon: 'alertCircle'
      });
      return;
    }

    btn.disabled = true;
    btn.querySelector('span:last-child').textContent = 'Checking...';
    document.getElementById('singleResultCard').classList.add('hidden');

    const country = countrySel.value;

    chrome.runtime.sendMessage({
      type: 'CHECK_SINGLE',
      number: rawVal,
      country
    }, async (resp) => {
      btn.disabled = false;
      btn.querySelector('span:last-child').textContent = 'Check Number';

      if (!resp || !resp.success) {
        showSingleResult('UNKNOWN', 'Error', (resp && resp.error) || 'Failed to communicate with service worker');
        return;
      }

      const res = resp.result;
      const { status, title, detail } = buildSingleResult(res.status, res.notes, resp.normalized);
      showSingleResult(status, title, detail);
    });
  });
}

// Map a check outcome to the UI copy; single source used by both live and restored results
function buildSingleResult(status, notes, normalized) {
  let title = 'Could Not Verify';
  let detail = notes || 'Check timed out or WhatsApp Web unreachable';
  if (status === 'REGISTERED') {
    title = 'Registered on WhatsApp';
    detail = normalized || '';
  } else if (status === 'NOT_REGISTERED') {
    title = 'Not Registered';
    detail = normalized || '';
  } else if (status === 'INVALID') {
    title = 'Invalid Phone Number';
    detail = notes || 'Malformed number format';
  }
  return { status, title, detail };
}

// Render persisted single-check state (result or in-flight "Checking..."), with a
// staleness guard for a marker left behind by a service worker that died mid-check
function applySingleState(s) {
  if (!s || !s.status) return;
  if (s.status === 'CHECKING') {
    const timeoutMs = s.timeoutMs || DEFAULT_SETTINGS.checkTimeoutSeconds * 1000;
    if (Date.now() - (s.timestamp || 0) > timeoutMs + 5000) {
      const r = buildSingleResult('UNKNOWN', 'Check timed out or WhatsApp Web unreachable', '');
      showSingleResult(r.status, r.title, r.detail);
      return;
    }
    showSingleResult('CHECKING', 'Checking...', s.detail || s.number || '');
    return;
  }
  if (s.title) {
    showSingleResult(s.status, s.title, s.detail);
  } else {
    const r = buildSingleResult(s.status, s.notes, s.normalized);
    showSingleResult(r.status, r.title, r.detail);
  }
}

function showSingleResult(status, title, detail) {
  const resultCard = document.getElementById('singleResultCard');
  const resultTitle = document.getElementById('singleResultTitle');
  const resultDetail = document.getElementById('singleResultDetail');
  const resultIcon = document.getElementById('singleResultIcon');

  resultCard.classList.remove('hidden');
  resultTitle.textContent = title;
  resultDetail.textContent = detail;

  if (status === 'REGISTERED') {
    resultIcon.innerHTML = getIcon('checkCircle');
    resultTitle.className = 'result-title status-reg';
  } else if (status === 'NOT_REGISTERED') {
    resultIcon.innerHTML = getIcon('xCircle');
    resultTitle.className = 'result-title status-not';
  } else if (status === 'INVALID') {
    resultIcon.innerHTML = getIcon('alertCircle');
    resultTitle.className = 'result-title status-not';
  } else {
    resultIcon.innerHTML = getIcon('helpCircle');
    resultTitle.className = 'result-title status-unk';
  }
}

// Bulk Mode Logic
function setupBulkMode() {
  const textarea = document.getElementById('bulkTextarea');
  const countrySel = document.getElementById('bulkCountrySelect');
  const btnStart = document.getElementById('btnStartBulk');
  const btnImportTxt = document.getElementById('btnImportTxt');
  const btnImportCsv = document.getElementById('btnImportCsv');
  const fileTxt = document.getElementById('fileInputTxt');
  const fileCsv = document.getElementById('fileInputCsv');

  const btnPause = document.getElementById('btnPauseJob');
  const btnResume = document.getElementById('btnResumeJob');
  const btnCancel = document.getElementById('btnCancelJob');
  const btnExportHtml = document.getElementById('btnExportHtml');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnNewCheck = document.getElementById('btnNewCheck');

  textarea.addEventListener('input', updatePreCheckStats);
  countrySel.addEventListener('change', updatePreCheckStats);

  btnImportTxt.addEventListener('click', () => fileTxt.click());
  btnImportCsv.addEventListener('click', () => fileCsv.click());

  const handleFileSelect = (evt) => {
    const file = evt.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      textarea.value = e.target.result || '';
      updatePreCheckStats();
    };
    reader.readAsText(file);
  };

  fileTxt.addEventListener('change', handleFileSelect);
  fileCsv.addEventListener('change', handleFileSelect);

  btnStart.addEventListener('click', () => {
    const rawText = textarea.value.trim();
    if (!rawText) {
      showAlert({
        title: 'Numbers Required',
        message: 'Please enter or import phone numbers',
        icon: 'alertCircle'
      });
      return;
    }

    const country = countrySel.value;
    chrome.runtime.sendMessage({
      type: 'START_JOB',
      rawText,
      defaultCountry: country
    }, async (resp) => {
      if (resp && resp.success) {
        await StateManager.clearDraftInput();
        activeJobState = resp.job;
        switchTab('bulk');
        renderBulkState();
      }
    });
  });

  btnPause.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_JOB' }, () => checkActiveJob());
  });

  btnResume.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RESUME_JOB' }, () => checkActiveJob());
  });

  btnCancel.addEventListener('click', async () => {
    const confirmed = await showModal({
      title: 'Cancel Active Check',
      message: 'Cancel active WhatsApp bulk check?',
      icon: 'stop',
      confirmLabel: 'Cancel Check',
      danger: true
    });
    if (confirmed) {
      chrome.runtime.sendMessage({ type: 'CANCEL_JOB' }, () => checkActiveJob());
    }
  });

  btnExportHtml.addEventListener('click', () => exportFile('html'));
  btnExportCsv.addEventListener('click', () => exportFile('csv'));

  btnNewCheck.addEventListener('click', async () => {
    const confirmed = await showModal({
      title: 'Clear Completed Job',
      message: 'Clear completed job and start a new check?',
      icon: 'refresh',
      confirmLabel: 'Clear & Start New',
      danger: true
    });
    if (confirmed) {
      chrome.runtime.sendMessage({ type: 'CLEAR_JOB' }, async () => {
        activeJobState = null;
        textarea.value = '';
        await StateManager.clearDraftInput();
        updatePreCheckStats();
        renderBulkState();
      });
    }
  });
}

function updatePreCheckStats() {
  const textarea = document.getElementById('bulkTextarea');
  const countrySel = document.getElementById('bulkCountrySelect');
  const statsBox = document.getElementById('bulkStatsBox');

  if (!textarea || !countrySel) return;

  const rawText = textarea.value;
  const country = countrySel.value;

  // Auto-save draft text & country on every stroke
  if (!activeJobState) {
    StateManager.saveDraftInput(rawText, country);
  }

  if (!rawText.trim()) {
    if (statsBox) statsBox.classList.add('hidden');
    return;
  }

  const parsed = parseImportContent(rawText, country);
  if (statsBox) statsBox.classList.remove('hidden');
  document.getElementById('statImported').textContent = parsed.totalImported;
  document.getElementById('statDuplicates').textContent = parsed.duplicatesCount;
  document.getElementById('statInvalid').textContent = parsed.invalidCount;
  document.getElementById('statReady').textContent = parsed.validCount;
}

function exportFile(format) {
  if (!activeJobState) return;

  let content = '';
  let filename = `whatsapp_report_${Date.now()}`;
  let mimeType = 'text/plain';

  if (format === 'html') {
    content = generateHtmlReport(activeJobState);
    filename += '.html';
    mimeType = 'text/html';
  } else {
    content = generateCsvReport(activeJobState);
    filename += '.csv';
    mimeType = 'text/csv';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Atomic State Restoration on Load
async function loadAndRestoreAllState() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

  // 1. Fetch active job synchronously via background runtime or storage
  activeJobState = await fetchActiveJobFromWorkerOrStorage();

  const data = await chrome.storage.local.get(['activeTab', 'settings', 'bulkDraft', 'singleDraft', 'singleState']);
  const defCountry = (data.settings && data.settings.defaultCountry) ? data.settings.defaultCountry : 'BD';

  // 2. Set default countries first
  const singleCountrySel = document.getElementById('singleCountrySelect');
  const bulkCountrySel = document.getElementById('bulkCountrySelect');
  const settingsCountrySel = document.getElementById('settingsDefaultCountry');

  if (singleCountrySel) singleCountrySel.value = defCountry;
  if (bulkCountrySel) bulkCountrySel.value = defCountry;
  if (settingsCountrySel) settingsCountrySel.value = defCountry;

  // 3. Restore Single Draft (typed number & selected country)
  if (data.singleDraft) {
    const singleInput = document.getElementById('singlePhoneInput');
    if (singleInput && data.singleDraft.number !== undefined) singleInput.value = data.singleDraft.number;
    if (singleCountrySel && data.singleDraft.country) singleCountrySel.value = data.singleDraft.country;
  }

  // 4. Restore Single Check Result Card (result, or in-flight "Checking..." state)
  if (data.singleState) {
    applySingleState(data.singleState);
  }

  // 5. IF AN ACTIVE JOB EXISTS (RUNNING, PAUSED, COMPLETED, CANCELLED), FORCIBLY DISPLAY BULK PROGRESS VIEW!
  if (activeJobState) {
    switchTab('bulk');
    renderBulkState();
  } else {
    if (data.activeTab) {
      switchTab(data.activeTab);
    } else {
      switchTab('single');
    }

    // Restore Bulk Draft Input (typed/imported numbers & selected country)
    if (data.bulkDraft) {
      const textarea = document.getElementById('bulkTextarea');
      if (textarea && data.bulkDraft.rawText !== undefined) {
        textarea.value = data.bulkDraft.rawText;
      }
      if (bulkCountrySel && data.bulkDraft.country) {
        bulkCountrySel.value = data.bulkDraft.country;
      }
      updatePreCheckStats();
    }

    renderBulkState();
  }
}

// Check stored active job state
async function checkActiveJob() {
  const job = await fetchActiveJobFromWorkerOrStorage();
  if (job) {
    activeJobState = job;
    renderBulkState();
  }
}

// Render Bulk UI State
function renderBulkState() {
  const inputContainer = document.getElementById('bulkInputContainer');
  const progressContainer = document.getElementById('bulkProgressContainer');

  if (!inputContainer || !progressContainer) return;

  if (!activeJobState) {
    inputContainer.classList.remove('hidden');
    progressContainer.classList.add('hidden');
    stopTimer();
    return;
  }

  inputContainer.classList.add('hidden');
  progressContainer.classList.remove('hidden');

  const statusBadge = document.getElementById('jobStatusBadge');
  const progressText = document.getElementById('jobProgressText');
  const progressBarFill = document.getElementById('progressBarFill');
  const currentVal = document.getElementById('currentNumberVal');

  const bkRegistered = document.getElementById('bkRegistered');
  const bkNotRegistered = document.getElementById('bkNotRegistered');
  const bkUnknown = document.getElementById('bkUnknown');

  const btnPause = document.getElementById('btnPauseJob');
  const btnResume = document.getElementById('btnResumeJob');
  const btnCancel = document.getElementById('btnCancelJob');
  const exportRow = document.getElementById('bulkExportRow');
  const btnNewCheck = document.getElementById('btnNewCheck');

  const total = activeJobState.validCount || 0;
  const completed = activeJobState.completedCount || 0;
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  progressText.textContent = `${completed} / ${total}`;
  progressBarFill.style.width = `${pct}%`;
  currentVal.textContent = activeJobState.currentNumber || 'Processing...';

  bkRegistered.textContent = activeJobState.stats?.registered || 0;
  bkNotRegistered.textContent = activeJobState.stats?.notRegistered || 0;
  bkUnknown.textContent = activeJobState.stats?.unknown || 0;

  statusBadge.textContent = activeJobState.status;

  if (activeJobState.status === 'RUNNING') {
    statusBadge.className = 'badge';
    btnPause.classList.remove('hidden');
    btnResume.classList.add('hidden');
    btnCancel.classList.remove('hidden');
    exportRow.classList.add('hidden');
    btnNewCheck.classList.add('hidden');
    startTimer();
  } else if (activeJobState.status === 'PAUSED') {
    statusBadge.className = 'badge';
    btnPause.classList.add('hidden');
    btnResume.classList.remove('hidden');
    btnCancel.classList.remove('hidden');
    exportRow.classList.remove('hidden');
    btnNewCheck.classList.add('hidden');
    stopTimer();
  } else if (activeJobState.status === 'COMPLETED' || activeJobState.status === 'CANCELLED') {
    statusBadge.className = 'badge';
    btnPause.classList.add('hidden');
    btnResume.classList.add('hidden');
    btnCancel.classList.add('hidden');
    exportRow.classList.remove('hidden');
    btnNewCheck.classList.remove('hidden');
    currentVal.textContent = activeJobState.status === 'COMPLETED' ? 'Check Finished' : 'Check Cancelled';
    stopTimer();
  }
}

// Timer logic & periodic sync poll
function startTimer() {
  if (timerInterval) return;
  updateTimerUI();
  timerInterval = setInterval(updateTimerUI, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  updateTimerUI();
}

function updateTimerUI() {
  if (!activeJobState) return;

  const elapsedEl = document.getElementById('jobElapsedTimer');
  const etaEl = document.getElementById('jobEtaTimer');

  const now = activeJobState.status === 'PAUSED'
    ? (activeJobState.pausedAt || Date.now())
    : (activeJobState.endTime || Date.now());
  // Exclude paused time so elapsed/ETA reflect active checking only; frozen while PAUSED
  const pausedMs = activeJobState.totalPausedMs || 0;
  const elapsedSeconds = Math.max(0, Math.floor((now - activeJobState.startTime - pausedMs) / 1000));

  const em = Math.floor(elapsedSeconds / 60);
  const es = elapsedSeconds % 60;
  if (elapsedEl) elapsedEl.textContent = `Elapsed: ${em > 0 ? em + 'm ' : ''}${es}s`;

  if (activeJobState.status === 'RUNNING' && activeJobState.completedCount > 0) {
    const total = activeJobState.validCount || 0;
    const remaining = Math.max(0, total - activeJobState.completedCount);
    const avgSecPerItem = elapsedSeconds / activeJobState.completedCount;
    const etaSeconds = Math.ceil(remaining * avgSecPerItem);

    const etaM = Math.floor(etaSeconds / 60);
    const etaS = etaSeconds % 60;
    if (etaEl) etaEl.textContent = `ETA: ${etaM > 0 ? etaM + 'm ' : ''}${etaS}s`;
  } else {
    if (etaEl) etaEl.textContent = 'ETA: --';
  }
}

// Custom modal (replaces native alert/confirm dialogs)
let modalResolve = null;
let lastFocusedElement = null;

function setupModal() {
  const overlay = document.getElementById('modalOverlay');
  const cancelBtn = document.getElementById('modalCancel');
  const confirmBtn = document.getElementById('modalConfirm');
  if (!overlay) return;

  const close = (value) => {
    if (!modalResolve) return;
    const resolve = modalResolve;
    modalResolve = null;
    overlay.classList.add('hidden');
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
    resolve(value);
  };

  cancelBtn.addEventListener('click', () => close(false));
  confirmBtn.addEventListener('click', () => close(true));

  overlay.addEventListener('click', (e) => {
    // Alert: only the OK button closes; confirm: overlay click cancels
    if (e.target === overlay && overlay.dataset.mode === 'confirm') close(false);
  });

  document.addEventListener('keydown', (e) => {
    if (!modalResolve) return;
    if (e.key === 'Escape') {
      close(false);
      return;
    }
    if (e.key === 'Tab') {
      const focusables = Array.from(overlay.querySelectorAll('button'))
        .filter((b) => !b.classList.contains('hidden'));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

function openModal({ title, message, icon, confirmLabel, danger, alertOnly }) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay) return Promise.resolve(false);
  if (!overlay.classList.contains('hidden')) return Promise.resolve(false);

  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalMessage').textContent = message;

  const iconWrap = document.getElementById('modalIconWrap');
  const iconEl = document.getElementById('modalIcon');
  if (icon && typeof getIcon === 'function') {
    iconEl.innerHTML = getIcon(icon);
    iconWrap.classList.remove('hidden');
  } else {
    iconWrap.classList.add('hidden');
  }

  const cancelBtn = document.getElementById('modalCancel');
  const confirmBtn = document.getElementById('modalConfirm');

  confirmBtn.className = 'btn modal-confirm btn-primary';
  confirmBtn.textContent = confirmLabel || 'OK';
  if (danger) confirmBtn.classList.add('danger');
  cancelBtn.classList.toggle('hidden', !!alertOnly);
  overlay.dataset.mode = alertOnly ? 'alert' : 'confirm';

  lastFocusedElement = document.activeElement;
  overlay.classList.remove('hidden');
  confirmBtn.focus();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

// Confirm-style modal; resolves true (confirm) or false (cancel/overlay/Escape)
function showModal(opts) {
  return openModal(Object.assign({ alertOnly: false }, opts));
}

// Alert-style modal; resolves true when the user presses OK
function showAlert(opts) {
  return openModal(Object.assign({ alertOnly: true, confirmLabel: 'OK' }, opts));
}

// Settings mode
function setupSettingsMode() {
  const radioButtons = document.querySelectorAll('input[name="theme"]');
  const defaultCountrySel = document.getElementById('settingsDefaultCountry');

  StateManager.getSettings().then(s => {
    const theme = s.theme || 'system';
    radioButtons.forEach(r => {
      if (r.value === theme) r.checked = true;
    });
    if (defaultCountrySel) defaultCountrySel.value = s.defaultCountry || 'BD';
  });

  radioButtons.forEach(r => {
    r.addEventListener('change', async (e) => {
      const selected = e.target.value;
      applyTheme(selected);
      await StateManager.saveSettings({ theme: selected });
    });
  });

  if (defaultCountrySel) {
    defaultCountrySel.addEventListener('change', async (e) => {
      await StateManager.saveSettings({ defaultCountry: e.target.value });
      const singleSel = document.getElementById('singleCountrySelect');
      const bulkSel = document.getElementById('bulkCountrySelect');
      if (singleSel) singleSel.value = e.target.value;
      if (bulkSel) bulkSel.value = e.target.value;
    });
  }
}
