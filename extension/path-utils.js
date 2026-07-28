// Shared by every page that writes into a per-item output subfolder
// (author/issue/journal-download/search/network/trending) — was six
// byte-for-byte-identical copies of sanitizeFolderName() (only the fallback
// name differed), the same drift risk keywords.js was extracted for
// earlier. Also fixes a real bug found via a Windows user's exported log:
// every one of those six sites built the subfolder path as a template
// string with a hardcoded "/", e.g. `${baseDir}/${folderName}`, even though
// baseDir on Windows is backslash-style (C:\Users\...\autorename) — that
// produces a legitimately-broken mixed-separator path
// (C:\Users\...\autorename/Walter Benjamin/download_log.txt) that Windows
// mostly tolerates but which breaks textual "already downloaded" path
// comparisons and confuses `explorer /select,`.

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make one metadata string (an author/journal/topic name from Crossref,
 * OpenAlex, or the user) safe to use as a single Windows/macOS/Linux path
 * component.
 */
function sanitizeFolderName(name, fallback) {
  let s = String(name || "")
    .replace(/[^\w\-. ]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  // Windows silently strips trailing dots/spaces from a path component when
  // creating it, but doesn't do the same when a string is only ever used to
  // *record* the intended name — the folder actually on disk and the name
  // saved for a later "already downloaded" comparison can end up differing
  // by exactly this, permanently defeating that comparison.
  s = s.replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED_NAME.test(s)) s = "_" + s;
  return s || fallback || "untitled";
}

/**
 * Join a base output directory with one or more path segments, using
 * whichever separator the base path itself already uses — rather than a
 * hardcoded "/", which produces a mixed-separator path on Windows.
 */
function joinOutputPath(base, ...parts) {
  const b = String(base || "");
  const sep = /^[a-zA-Z]:[\\/]/.test(b) || b.includes("\\") ? "\\" : "/";
  const segs = parts.map((p) => String(p).replace(/^[\\/]+|[\\/]+$/g, "")).filter(Boolean);
  return [b.replace(/[\\/]+$/, ""), ...segs].join(sep);
}
