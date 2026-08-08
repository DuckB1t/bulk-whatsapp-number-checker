/**
 * State Persistence Layer
 * Interacts directly with chrome.storage.local for jobs, settings, drafts, and UI state.
 */

const DEFAULT_SETTINGS = {
  theme: 'system',
  defaultCountry: 'BD',
  checkTimeoutSeconds: 20,
  interCheckDelayMs: 1500
};

const StateManager = {
  async getSettings() {
    const data = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  },

  async saveSettings(newSettings) {
    const current = await StateManager.getSettings();
    const updated = { ...current, ...newSettings };
    await chrome.storage.local.set({ settings: updated });
    return updated;
  },

  async getActiveJob() {
    const data = await chrome.storage.local.get('activeJob');
    return data.activeJob || null;
  },

  async saveActiveJob(job) {
    await chrome.storage.local.set({ activeJob: job });
    return job;
  },

  async clearActiveJob() {
    await chrome.storage.local.remove('activeJob');
  },

  async getDraftInput() {
    const data = await chrome.storage.local.get('bulkDraft');
    return data.bulkDraft || { rawText: '', country: 'BD' };
  },

  async saveDraftInput(rawText, country) {
    await chrome.storage.local.set({ bulkDraft: { rawText, country, updatedAt: Date.now() } });
  },

  async clearDraftInput() {
    await chrome.storage.local.remove('bulkDraft');
  },

  async getSingleDraft() {
    const data = await chrome.storage.local.get('singleDraft');
    return data.singleDraft || { number: '', country: 'BD' };
  },

  async saveSingleDraft(number, country) {
    await chrome.storage.local.set({ singleDraft: { number, country, updatedAt: Date.now() } });
  },

  async getSingleState() {
    const data = await chrome.storage.local.get('singleState');
    return data.singleState || null;
  },

  async saveSingleState(stateObj) {
    await chrome.storage.local.set({ singleState: stateObj });
  },

  createJob(parsedData) {
    const now = Date.now();
    const numbers = parsedData.items || [];
    const validNumbers = numbers.filter(n => n.status === 'PENDING');
    const preInvalidCount = numbers.filter(n => n.status === 'INVALID').length;

    return {
      jobId: `job_${now}`,
      status: 'RUNNING', // RUNNING | PAUSED | CANCELLED | COMPLETED
      totalImported: parsedData.totalImported || 0,
      duplicateCount: parsedData.duplicatesCount || 0,
      invalidCount: parsedData.invalidCount || 0,
      validCount: parsedData.validCount || validNumbers.length,
      completedCount: 0,
      currentIndex: 0,
      currentNumber: validNumbers[0]?.normalized || '',
      pausedAt: null,
      totalPausedMs: 0,
      startTime: now,
      endTime: null,
      stats: {
        registered: 0,
        notRegistered: 0,
        unknown: 0,
        invalid: preInvalidCount
      },
      numbers
    };
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.StateManager = StateManager;
  globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
}
