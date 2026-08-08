/**
 * WhatsApp Web State Inspection Content Script
 * Runs inside web.whatsapp.com to inspect DOM state when validating phone numbers.
 */

(function () {
  let isInspecting = false;
  let checkInterval = null;
  let observer = null;

  function stopInspection() {
    isInspecting = false;
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // Stop immediately when the page starts navigating away, so a stale interval
  // can't read the next page's DOM and send a duplicate/cross-wired result.
  window.addEventListener('pagehide', stopInspection);
  window.addEventListener('beforeunload', stopInspection);

  function sendResult(status, notes = '') {
    stopInspection();
    try {
      chrome.runtime.sendMessage({
        type: 'WHATSAPP_CHECK_RESULT',
        status, // 'REGISTERED' | 'NOT_REGISTERED' | 'UNKNOWN' | 'NOT_LOGGED_IN'
        notes
      });
    } catch (e) {
      console.warn('Could not send WhatsApp inspection result:', e);
    }
  }

  function inspectDom() {
    if (!isInspecting) return;
    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';

    // 1. Check if logged out (QR Code visible)
    const isLoggedOut = document.querySelector('canvas[aria-label*="Scan"]') ||
      bodyText.includes('to use whatsapp on your computer') ||
      bodyText.includes('link with phone number');

    if (isLoggedOut && !document.querySelector('#main')) {
      sendResult('NOT_LOGGED_IN', 'WhatsApp Web is not logged in');
      return;
    }

    // 2. Check for Invalid Phone Number Dialog / Modal
    const dialogs = document.querySelectorAll('div[role="dialog"], div[data-animate-modal-popup="true"], div._a9-v');
    for (const dialog of dialogs) {
      const dialogText = dialog.innerText.toLowerCase();
      if (
        dialogText.includes('invalid') ||
        dialogText.includes('on whatsapp') ||
        dialogText.includes('phone number shared via url is invalid') ||
        dialogText.includes('could not find')
      ) {
        sendResult('NOT_REGISTERED', 'WhatsApp Web reported number as invalid or not registered');
        return;
      }
    }

    // 3. Check for Valid Registered Chat Session
    const chatInput = document.querySelector('#main div[contenteditable="true"]') ||
      document.querySelector('footer div[contenteditable="true"]') ||
      document.querySelector('#main header');

    if (chatInput) {
      sendResult('REGISTERED', 'Chat session loaded successfully');
      return;
    }
  }

  function startInspection() {
    if (!window.location.href.includes('web.whatsapp.com/send')) {
      return;
    }

    if (isInspecting) return;
    isInspecting = true;

    inspectDom();

    // The check tab is always hidden, where Chrome throttles setInterval hard;
    // a MutationObserver fires on DOM change immediately even in hidden tabs.
    checkInterval = setInterval(inspectDom, 500);

    observer = new MutationObserver(() => {
      if (isInspecting) inspectDom();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInspection);
  } else {
    startInspection();
  }
})();
