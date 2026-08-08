/**
 * Sequential Queue Controller
 * Strictly processes one number at a time and manages state machine transitions safely.
 */

class QueueController {
  constructor() {
    this.isProcessing = false;
    this.executeCheckTask = null;
  }

  setCheckExecutor(fn) {
    this.executeCheckTask = fn;
  }

  async startOrResumeJob() {
    if (this.isProcessing) return;

    const job = await StateManager.getActiveJob();
    if (!job || job.status !== 'RUNNING') {
      return;
    }

    this.isProcessing = true;
    this.processLoop();
  }

  async pauseJob() {
    const job = await StateManager.getActiveJob();
    if (job) {
      job.status = 'PAUSED';
      job.pausedAt = Date.now();
      await StateManager.saveActiveJob(job);
    }
    this.notifyStateChanged();
  }

  async cancelJob() {
    const job = await StateManager.getActiveJob();
    if (job) {
      job.status = 'CANCELLED';
      job.endTime = Date.now();
      await StateManager.saveActiveJob(job);
    }
    this.isProcessing = false;
    this.notifyStateChanged();
  }

  async processLoop() {
    while (this.isProcessing) {
      const job = await StateManager.getActiveJob();

      if (!job || job.status !== 'RUNNING') {
        this.isProcessing = false;
        break;
      }

      // Find next pending or interrupted checking item
      const pendingIndex = job.numbers.findIndex(item => item.status === 'PENDING' || item.status === 'CHECKING');

      if (pendingIndex === -1) {
        // All numbers processed!
        job.status = 'COMPLETED';
        job.endTime = Date.now();
        await StateManager.saveActiveJob(job);
        this.isProcessing = false;
        this.notifyStateChanged();
        break;
      }

      job.currentIndex = pendingIndex;
      const currentItem = job.numbers[pendingIndex];
      currentItem.status = 'CHECKING';
      job.currentNumber = currentItem.normalized;
      await StateManager.saveActiveJob(job);
      this.notifyStateChanged();

      const settings = await StateManager.getSettings();
      const timeoutMs = (settings.checkTimeoutSeconds || DEFAULT_SETTINGS.checkTimeoutSeconds) * 1000;

      let result;
      if (typeof this.executeCheckTask === 'function') {
        try {
          result = await this.executeCheckTask(currentItem, timeoutMs);
        } catch (err) {
          result = {
            status: 'UNKNOWN',
            notes: err.message || 'Verification execution failed'
          };
        }
      } else {
        result = { status: 'UNKNOWN', notes: 'No check executor configured' };
      }

      // Reload job from storage in case user pressed Pause or Cancel during execution
      const updatedJob = await StateManager.getActiveJob();
      if (!updatedJob) {
        this.isProcessing = false;
        break;
      }

      // Record item verification result
      currentItem.status = result.status; // REGISTERED | NOT_REGISTERED | UNKNOWN
      currentItem.checkedAt = Date.now();
      currentItem.notes = result.notes || '';

      updatedJob.numbers[pendingIndex] = currentItem;
      updatedJob.completedCount++;

      if (result.status === 'REGISTERED') updatedJob.stats.registered++;
      else if (result.status === 'NOT_REGISTERED') updatedJob.stats.notRegistered++;
      else if (result.status === 'UNKNOWN') updatedJob.stats.unknown++;

      if (updatedJob.status === 'PAUSED' || updatedJob.status === 'CANCELLED') {
        await StateManager.saveActiveJob(updatedJob);
        this.isProcessing = false;
        this.notifyStateChanged();
        break;
      }

      await StateManager.saveActiveJob(updatedJob);
      this.notifyStateChanged();

      // Inter-check delay to allow WhatsApp Web tab to reset cleanly
      const delayMs = settings.interCheckDelayMs || DEFAULT_SETTINGS.interCheckDelayMs;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  notifyStateChanged() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'JOB_STATE_UPDATED' }).catch(() => {
        // Popup may be closed, ignore message error
      });
    }
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.QueueController = QueueController;
}
