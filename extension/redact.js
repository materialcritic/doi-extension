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
  // account name masked. Not the only place redactPath() gets applied any
  // more (see sanitizeForLog's universal fallback below) — kept mainly for
  // readability, so a reader can see which fields are known path-shaped.
  const PATH_KEYS = /^(filepath|file_path|path|outputDir|output_dir|outputDirOverride|folder|scriptPath|pythonPath|dir)$/i;
  const STACK_KEYS = /^(stack|stacktrace|stack_trace)$/i;

  function redactUrl(raw) {
    const s = String(raw == null ? "" : raw);
    if (!s) return s;

    // Our own extension pages: the path AND its params are the useful signal
    // (e.g. author.html?author=Walter%20Benjamin) and contain nothing secret
    // -- EXCEPT some pages (page-scan.html?url=...&title=...) pass a real
    // filesystem path through their own query string as a param value, and
    // it's usually percent-encoded there (so a plain redactPath() pass over
    // the raw string wouldn't see "/Users/name/", only "%2FUsers%2Fname%2F").
    // Best-effort decode first so that path becomes visible to redactPath()
    // before this returns -- falls back to the still-encoded string if it
    // isn't validly encoded (e.g. was truncated elsewhere mid-escape).
    if (s.startsWith("chrome-extension://")) {
      let decoded = s;
      try {
        decoded = decodeURIComponent(s);
      } catch (_) {
        // not validly percent-encoded (or truncated mid-escape) -- redact
        // the raw string instead of losing this log line entirely
      }
      decoded = redactPath(decoded);
      return decoded.length > 500 ? decoded.slice(0, 500) + "…" : decoded;
    }

    try {
      const u = new URL(s);
      // redactPath() before the length truncation below, not after -- a
      // file:// URL's username sits in the pathname (e.g.
      // file:///Users/name/Downloads/...), and truncating first could in
      // principle cut it off *after* it's already been logged if a future
      // MAX_PATH_SEGMENT change moved the cutoff past it; redacting first is
      // correct regardless of where the cutoff lands.
      let path = redactPath(u.pathname || "");
      if (path.length > MAX_PATH_SEGMENT) path = path.slice(0, MAX_PATH_SEGMENT) + "…";
      // Record only THAT there was a query/fragment, never its contents.
      const marker = (u.search ? "?…" : "") + (u.hash ? "#…" : "");
      return `${u.protocol}//${u.host}${path}${marker}`;
    } catch (_) {
      return "[unparseable-url]";
    }
  }

  /** Mask the user's home directory so a log is safe to attach to a bug
   * report. Deliberately NOT anchored to the start of the string (a real
   * user's exported log showed this matters: appendLog's "line" field is a
   * whole download-log line with the path embedded in the middle, e.g.
   * "... | SUCCESS | 10.1234/x | Title | /Users/name/Downloads/x.pdf") and
   * globally replaces every occurrence, not just the first. */
  function redactPath(raw) {
    return String(raw == null ? "" : raw)
      .replace(/([a-zA-Z]:[\\/]Users[\\/])[^\\/]+/gi, "$1<user>")
      .replace(/(\/(?:home|Users)\/)[^/]+/g, "$1<user>");
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
   *
   * A real user's exported log showed the URL_KEYS/PATH_KEYS allowlist alone
   * isn't enough: any key we hadn't thought to list (outputDirOverride,
   * folder, a free-text "line" field embedding a path mid-string) sailed
   * through completely unredacted -- 651 raw occurrences of the OS username
   * in one export. Every plain string value, not just ones under a
   * recognized key, now also gets a redactPath() pass in the base case
   * below -- a global no-op if there's nothing to redact, so this is a safe
   * blanket fallback rather than something that needs every future
   * sensitive field name added to a list by hand.
   */
  function sanitizeForLog(value, depth) {
    depth = depth || 0;
    if (depth > 4) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    // Only strings get redactPath()'d -- it coerces via String(), which
    // would otherwise silently turn a number/boolean (tabId, a citation
    // count, ...) into a string in the logged output.
    if (typeof value !== "object") return typeof value === "string" ? truncate(redactPath(value)) : value;
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
