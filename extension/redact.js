// Sanitizes values before they're written to any persisted log or export
// bundle. Loaded both as a content script (via manifest.json, before
// logger.js) and in the service worker (via importScripts() in background.js,
// since it isn't a module) — so it must not assume either `window` or ES
// module syntax, only whatever global object it's attached to.
(function (root) {
  "use strict";

  const MAX_STRING = 300;
  const MAX_PATH_SEGMENT = 120;

  // Keys whose string values are URLs and must be stripped of query/hash —
  // that's where the actual secrets live (auth tokens, compose ids, search
  // terms), never in the origin+path, which is the only part useful for
  // diagnosing this extension.
  const URL_KEYS = /^(url|tabUrl|tab_url|filename|referrer|href|src|documentURI|pageUrl)$/i;
  // Keys whose string values are filesystem paths and must have the OS
  // account name masked.
  const PATH_KEYS = /^(filepath|file_path|path|outputDir|output_dir|scriptPath|pythonPath|dir)$/i;
  const STACK_KEYS = /^(stack|stacktrace|stack_trace)$/i;

  function redactUrl(raw) {
    const s = String(raw == null ? "" : raw);
    if (!s) return s;

    // Our own extension pages: the path AND its params are the useful signal
    // (e.g. author.html?author=Walter%20Benjamin) and contain nothing secret.
    if (s.startsWith("chrome-extension://")) {
      return s.length > 500 ? s.slice(0, 500) + "…" : s;
    }

    try {
      const u = new URL(s);
      let path = u.pathname || "";
      if (path.length > MAX_PATH_SEGMENT) path = path.slice(0, MAX_PATH_SEGMENT) + "…";
      // Record only THAT there was a query/fragment, never its contents.
      const marker = (u.search ? "?…" : "") + (u.hash ? "#…" : "");
      return `${u.protocol}//${u.host}${path}${marker}`;
    } catch (_) {
      return "[unparseable-url]";
    }
  }

  /** Mask the user's home directory so a log is safe to attach to a bug report. */
  function redactPath(raw) {
    return String(raw == null ? "" : raw)
      .replace(/^([a-zA-Z]:[\\/]Users[\\/])[^\\/]+/i, "$1<user>")
      .replace(/^(\/(?:home|Users)\/)[^/]+/, "$1<user>");
  }

  /** Keep extension frames in a stack trace; redact page frames' URLs. */
  function redactStack(raw) {
    if (!raw) return raw;
    return String(raw)
      .split("\n")
      .slice(0, 20)
      .map((line) => line.replace(/(https?:\/\/[^\s)]+)/g, (m) => redactUrl(m)))
      .join("\n");
  }

  function truncate(v) {
    if (typeof v !== "string") return v;
    return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + "…" : v;
  }

  /**
   * Recursively sanitize an arbitrary detail object destined for the log.
   * Unknown keys are truncated but preserved; known-sensitive keys are rewritten.
   */
  function sanitizeForLog(value, depth) {
    depth = depth || 0;
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return truncate(value);
    if (Array.isArray(value)) {
      return value.slice(0, 25).map((v) => sanitizeForLog(v, depth + 1));
    }

    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (typeof v === "string" && URL_KEYS.test(key)) out[key] = redactUrl(v);
      else if (typeof v === "string" && PATH_KEYS.test(key)) out[key] = redactPath(v);
      else if (typeof v === "string" && STACK_KEYS.test(key)) out[key] = redactStack(v);
      else out[key] = sanitizeForLog(v, depth + 1);
    }
    return out;
  }

  /** Sanitize an already-persisted log entry (used by the migration below). */
  function sanitizeLogEntry(entry) {
    if (!entry || typeof entry !== "object") return entry;
    const out = Object.assign({}, entry);
    if (out.data !== undefined) out.data = sanitizeForLog(out.data, 0);
    if (typeof out.message === "string") out.message = redactStack(redactUrl(out.message));
    return out;
  }

  root.DOIRedact = { redactUrl, redactPath, redactStack, sanitizeForLog, sanitizeLogEntry };
})(typeof self !== "undefined" ? self : globalThis);
