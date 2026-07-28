// Shared on every extension page and as a content script (see manifest.json):
// auto-captures uncaught errors/rejections for free, and exposes doiLog() for
// explicit action/error logging. All it does is forward to background.js,
// which owns the actual chrome.storage.local write (a page or content script
// can be torn down mid-write; the service worker is the one place logging
// state can live reliably). See background.js's logEvent() for the format.
(function () {
  function pageSource() {
    try {
      if (location.protocol === "chrome-extension:") {
        return (location.pathname || "").replace(/^\//, "") || "background";
      }
    } catch (e) { /* fall through */ }
    return "content-script"; // running on an arbitrary web page
  }
  const SOURCE = pageSource();
  const IS_CONTENT_SCRIPT = SOURCE === "content-script";

  // Browser-generated noise that never indicates a bug in this extension.
  // A content script's window.addEventListener("error", ...) sees errors
  // from the HOST PAGE too (Gmail, YouTube, ...), not just our own code, and
  // these fire constantly on large sites — logging them drowned out every
  // real error and, worse, carried the host page's own URL/state with them.
  const BENIGN_ERROR_PATTERNS = [
    /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
    /^Script error\.?$/i, // cross-origin script, no detail available
    /Non-Error promise rejection captured/i,
  ];
  function isBenignError(message) {
    const msg = String(message == null ? "" : message);
    return BENIGN_ERROR_PATTERNS.some((re) => re.test(msg));
  }

  // True unless this is a content script AND the error's filename/stack
  // don't point back into our own extension code — i.e. it's the host
  // page's own error, not ours. Content scripts run in an isolated JS world
  // sharing only the DOM, so our own frames report a chrome-extension://
  // filename while the page's own scripts report the page's origin; that's
  // enough to tell them apart. Extension pages never run third-party code,
  // so every error there is already "our own" and this check is skipped.
  function isOwnError(filename, stack) {
    if (!IS_CONTENT_SCRIPT) return true;
    return [filename, stack].some((c) => typeof c === "string" && c.includes("chrome-extension://"));
  }

  window.doiLog = function (level, message, data) {
    try {
      const payload = {
        action: "logEvent",
        level: level || "info",
        source: SOURCE,
        message: String(message || ""),
        data: data || null,
      };
      // On a content script, the page URL is the single most useful piece of
      // context (which site/journal triggered this) — attach it if the
      // caller didn't already include one. background.js's logEvent()
      // redacts the query/fragment before this is ever persisted.
      if (IS_CONTENT_SCRIPT && (!data || !("url" in data))) {
        payload.data = Object.assign({ url: location.href }, data || {});
      }
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch (e) {
      // Extension context can be gone (page closing, extension just
      // reloaded while this script is still injected) — logging must never
      // itself throw into whatever called it.
    }
  };

  window.addEventListener("error", (e) => {
    if (isBenignError(e.message)) return;
    if (!isOwnError(e.filename, e.error && e.error.stack)) return; // the host page's problem, not ours
    window.doiLog("error", "Uncaught error: " + e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const message = reason && reason.message ? reason.message : String(reason);
    if (isBenignError(message)) return;
    const stack = reason && reason.stack;
    if (!isOwnError(null, stack)) return;
    window.doiLog("error", "Unhandled promise rejection: " + message, { stack });
  });
})();
