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
      // caller didn't already include one.
      if (SOURCE === "content-script" && (!data || !("url" in data))) {
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
    window.doiLog("error", "Uncaught error: " + e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    window.doiLog(
      "error",
      "Unhandled promise rejection: " + (reason && reason.message ? reason.message : String(reason)),
      { stack: reason && reason.stack }
    );
  });
})();
