const NATIVE_HOST = "com.doi_grabber.host";

// Tracks the DOI last checked per tab, so we don't re-run the check
// every time the content script fires on the same page.
const lastCheckedDOI = {};

// Tracks per-tab state (DOI, title, authors, availability) so keyboard
// shortcuts can act on "the current paper" without re-scanning the page.
const tabState = {};

// Journal watchlist: periodically polls Crossref for each watched journal's
// latest issue and notifies when it advances past the stored baseline.
const WATCHLIST_ALARM = "checkWatchlist";
const WATCHLIST_PERIOD_MINUTES = 360; // 6 hours

// Author watchlist: same idea, keyed by author name instead of ISSN — polls
// for that author's most recent Crossref work and notifies on a new DOI.
const AUTHOR_WATCHLIST_ALARM = "checkAuthorWatchlist";

// Self-update: periodically asks the native host to `git fetch` the repo
// checkout it's running from and reports how many commits behind origin it
// is. Result is cached in chrome.storage.local so the popup can show a
// lightweight "Update available" hint without its own native-messaging round trip.
const UPDATE_CHECK_ALARM = "checkForUpdate";
const UPDATE_CHECK_PERIOD_MINUTES = 720; // 12 hours

// notifId -> issue params, so a click can open the right issue page.
// Not persisted — a service worker restart just means old notifications
// silently stop being clickable, which is an acceptable tradeoff here.
const pendingWatchNotifications = {};

const GRAB_DOI_MENU_ID = "doi-grabber-grab-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(WATCHLIST_ALARM, { periodInMinutes: WATCHLIST_PERIOD_MINUTES });
  chrome.alarms.create(AUTHOR_WATCHLIST_ALARM, { periodInMinutes: WATCHLIST_PERIOD_MINUTES });
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES });

  // Context menu items persist across service-worker restarts once created
  // by the browser — only (re-)create on install/update, not on every
  // startup, or a second create() with the same id throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: GRAB_DOI_MENU_ID,
      title: "Grab DOI from selection",
      contexts: ["selection"],
    });
  });

  refreshUpdateCache();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHLIST_ALARM, { periodInMinutes: WATCHLIST_PERIOD_MINUTES });
  chrome.alarms.create(AUTHOR_WATCHLIST_ALARM, { periodInMinutes: WATCHLIST_PERIOD_MINUTES });
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES });

  refreshUpdateCache();
});

// Runs a check_for_update native-host round trip and caches the result in
// chrome.storage.local (not .sync — this is per-machine checkout state, same
// reasoning as potdNonce/potdHistory) for the popup's lightweight hint.
function refreshUpdateCache() {
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener((message) => {
    if (message.type === "progress") return;
    if (message.status === "ok") {
      chrome.storage.local.set({
        updateInfo: {
          behindBy: message.behind_by,
          commits: message.commits,
          localSha: message.local_sha,
          checkedAt: Date.now(),
        },
      });
    }
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {});
  port.postMessage({ action: "check_for_update" });
}

// Loosely matches a DOI anywhere in arbitrary selected text — a "10.xxxx/..."
// token, optionally prefixed with "doi:" or wrapped in a doi.org URL.
function extractDOIFromText(text) {
  if (!text) return null;
  const urlMatch = text.match(/doi\.org\/(10\.\d{4,}(?:\.\d+)*\/\S+)/i);
  if (urlMatch) return cleanSelectionDOI(urlMatch[1]);
  const bareMatch = text.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)/);
  if (bareMatch) return cleanSelectionDOI(bareMatch[1]);
  return null;
}

function cleanSelectionDOI(doi) {
  return doi.replace(/[.,;)\]}"'>]+$/, "").trim();
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== GRAB_DOI_MENU_ID) return;
  const doi = extractDOIFromText(info.selectionText);
  if (!doi) {
    chrome.notifications.create("doi-grab-selection-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "No DOI found",
      message: `Couldn't find a DOI in: "${(info.selectionText || "").slice(0, 80)}"`,
    });
    return;
  }
  downloadDOI(doi);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHLIST_ALARM) checkWatchlist();
  if (alarm.name === AUTHOR_WATCHLIST_ALARM) checkAuthorWatchlist();
  if (alarm.name === UPDATE_CHECK_ALARM) refreshUpdateCache();
});

chrome.notifications.onClicked.addListener((notifId) => {
  const info = pendingWatchNotifications[notifId];
  if (!info) return;
  const { page, ...params } = info;
  const query = new URLSearchParams(params);
  chrome.tabs.create({ url: chrome.runtime.getURL(page) + "?" + query.toString() });
  chrome.notifications.clear(notifId);
  delete pendingWatchNotifications[notifId];
});

// Fetches just the single most recent work in a journal, sorted by
// publication date, to read off its current latest volume/issue.
function fetchLatestIssue(issn) {
  const url = `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works` +
    `?rows=1&sort=published&order=desc&select=volume,issue,published-print,published-online`;
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
      return r.json();
    })
    .then((data) => {
      const item = data.message && data.message.items && data.message.items[0];
      if (!item) return null;
      const dateParts = (item["published-print"] || item["published-online"] || {})["date-parts"];
      const year = dateParts && dateParts[0] && dateParts[0][0];
      return { volume: item.volume || null, issue: item.issue || null, year: year || null };
    });
}

// Checks every watched journal against its stored baseline; notifies (and
// advances the baseline) for any that have a newer issue since last check.
// A journal with no baseline yet (just added) is silently seeded instead of
// notified, so subscribing doesn't immediately "announce" the current issue.
function checkWatchlist() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ watchlist: [] }, ({ watchlist }) => {
      if (watchlist.length === 0) return resolve();

      let changed = false;
      const checks = watchlist.map((entry) =>
        fetchLatestIssue(entry.issn)
          .then((latest) => {
            if (!latest || !latest.volume || !latest.issue) return;

            if (entry.volume == null || entry.issue == null) {
              entry.volume = latest.volume;
              entry.issue = latest.issue;
              entry.year = latest.year;
              changed = true;
              return;
            }

            if (String(latest.volume) !== String(entry.volume) || String(latest.issue) !== String(entry.issue)) {
              const notifId = "doi-watch-" + Date.now() + "-" + Math.random().toString(36).slice(2);
              pendingWatchNotifications[notifId] = {
                page: "issue.html",
                issn: entry.issn,
                volume: latest.volume,
                issue: latest.issue,
                journal: entry.journal || "",
                year: latest.year || "",
              };
              chrome.notifications.create(notifId, {
                type: "basic",
                iconUrl: "icons/icon128.png",
                title: "New issue available",
                message: `${entry.journal || "Journal"} — Vol. ${latest.volume}, Issue ${latest.issue}`,
              });
              entry.volume = latest.volume;
              entry.issue = latest.issue;
              entry.year = latest.year;
              changed = true;
            }
          })
          .catch(() => {}) // one journal failing shouldn't block the rest
      );

      Promise.all(checks).then(() => {
        if (changed) chrome.storage.sync.set({ watchlist }, resolve);
        else resolve();
      });
    });
  });
}

// Fetches an author's single most recent work on Crossref (name-matched the
// same way the author-works page matches), to read off its DOI/title/year.
function fetchLatestAuthorWork(author) {
  const { family, given } = parseAuthorName(author);
  const url = "https://api.crossref.org/works?query.author=" +
    encodeURIComponent(author || "") + "&rows=5&sort=published&order=desc&select=DOI,title,author,published-print,published-online";

  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
      return r.json();
    })
    .then((data) => {
      const items = (data.message && data.message.items) || [];
      const match = items.find((item) => matchesAuthor(item.author || [], family, given));
      if (!match) return null;
      const dateParts = (match["published-print"] || match["published-online"] || {})["date-parts"];
      const year = dateParts && dateParts[0] && dateParts[0][0];
      return {
        doi: match.DOI || null,
        title: decodeHtmlEntities((match.title && match.title[0]) || "(untitled)"),
        year: year || null,
      };
    });
}

// Checks every watched author against its stored baseline DOI; notifies
// (and advances the baseline) for any with a newer work since last check.
// An author with no baseline yet (just added) is silently seeded instead of
// notified, so subscribing doesn't immediately "announce" their latest work.
function checkAuthorWatchlist() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ authorWatchlist: [] }, ({ authorWatchlist }) => {
      if (authorWatchlist.length === 0) return resolve();

      let changed = false;
      const checks = authorWatchlist.map((entry) =>
        fetchLatestAuthorWork(entry.author)
          .then((latest) => {
            if (!latest || !latest.doi) return;

            if (!entry.doi) {
              entry.doi = latest.doi;
              entry.title = latest.title;
              entry.year = latest.year;
              changed = true;
              return;
            }

            if (latest.doi !== entry.doi) {
              const notifId = "doi-watch-author-" + Date.now() + "-" + Math.random().toString(36).slice(2);
              pendingWatchNotifications[notifId] = {
                page: "author.html",
                author: entry.author,
              };
              chrome.notifications.create(notifId, {
                type: "basic",
                iconUrl: "icons/icon128.png",
                title: "New work available",
                message: `${entry.author} — ${latest.title}`,
              });
              entry.doi = latest.doi;
              entry.title = latest.title;
              entry.year = latest.year;
              changed = true;
            }
          })
          .catch(() => {}) // one author failing shouldn't block the rest
      );

      Promise.all(checks).then(() => {
        if (changed) chrome.storage.sync.set({ authorWatchlist }, resolve);
        else resolve();
      });
    });
  });
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["outputDir", "pythonBin", "scriptPath", "mirrors", "unpaywallEmail"], resolve);
  });
}

// Mirrors the --ok/--err CSS variables defined per theme in popup.html,
// options.html, etc. — kept in sync manually since a service worker has no
// DOM/CSS to read the real values from.
const THEME_BADGE_COLORS = {
  dark:      { ok: "#4caf78", err: "#e0574a" },
  parchment: { ok: "#2f8f5d", err: "#c0392b" },
  slate:     { ok: "#2f8f5d", err: "#c0392b" },
  sage:      { ok: "#2f8f5d", err: "#c0392b" },
  minimal:   { ok: "#1a7a4c", err: "#b3261e" },
  carrot:    { ok: "#4a8f3c", err: "#c0392b" },
};

function getBadgeColors() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ theme: "dark" }, (items) => {
      resolve(THEME_BADGE_COLORS[items.theme] || THEME_BADGE_COLORS.dark);
    });
  });
}

function setAvailableBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: "✓" });
  getBadgeColors().then((colors) => {
    chrome.action.setBadgeBackgroundColor({ tabId, color: colors.ok });
  });
}

function setUnavailableBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: "✗" });
  getBadgeColors().then((colors) => {
    chrome.action.setBadgeBackgroundColor({ tabId, color: colors.err });
  });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: "" });
}

function buildSearchQuery(title, authors) {
  const query = [title, authors && authors[0]].filter(Boolean).join(" ");
  return query.trim();
}

// Crossref abstracts come back as JATS XML (e.g. "<jats:p>...</jats:p>") —
// strip tags and collapse whitespace down to plain text for display.
function stripJatsAbstract(xml) {
  if (!xml) return null;
  const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return decodeHtmlEntities(text) || null;
}

// OpenAlex stores abstracts as a word -> [positions] inverted index (to
// dodge publisher copyright on the raw text) rather than as plain text —
// rebuild the sentence by placing each word back at its recorded position.
function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex) return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  // OpenAlex mis-scrapes some Taylor & Francis review-essay/notes pieces —
  // instead of (or in addition to) a real abstract, the endnotes text ends
  // up in this field, always led by Tandfonline's figure-viewer boilerplate.
  // Treat that as "no real abstract" rather than showing footnotes as if
  // they were one.
  if (/^Click to increase image size/i.test(text)) return null;

  return text;
}

// Crossref's metadata (titles, journal/container-title, author names) often
// contains literal HTML-escaped entities baked into the text itself (e.g.
// "Philosophy &amp; Social Criticism" as the actual string, not markup) —
// a service worker has no DOM/DOMParser to lean on, so this decodes the
// common named + numeric entities by hand.
const HTML_NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => HTML_NAMED_ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Splits a free-text "Given Family" string the way Crossref's author
// records do, so results can be matched against the family/given fields
// Crossref returns rather than trusting its full-text author-query ranking
// alone (that alone pulled in false positives during testing).
function parseAuthorName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  const family = (parts.length > 1 ? parts[parts.length - 1] : parts[0] || "").toLowerCase();
  const given = parts.slice(0, -1).join(" ").toLowerCase();
  return { family, given };
}

function matchesAuthor(authors, family, given) {
  return authors.some((a) => {
    const f = (a.family || "").toLowerCase();
    const g = (a.given || "").toLowerCase();
    return f === family && (!given || g.includes(given.split(" ")[0]) || given.includes(g.split(" ")[0] || "\0"));
  });
}

// Availability checks hit Sci-Hub's mirrors directly. Running several at
// once (e.g. opening a bunch of tabs together) makes the mirrors flaky and
// causes false "unavailable" results, so we run checks one at a time.
const checkQueue = [];
let checkInFlight = false;

function runNextCheck() {
  if (checkInFlight || checkQueue.length === 0) return;
  const { doi, tabId, title, authors } = checkQueue.shift();
  checkInFlight = true;

  getSettings().then((settings) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    const finish = () => {
      checkInFlight = false;
      runNextCheck();
    };

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      if (message.status === "available") {
        setAvailableBadge(tabId);
        tabState[tabId] = { doi, title, authors, status: "available" };
      } else if (message.status === "unavailable") {
        setUnavailableBadge(tabId);
        tabState[tabId] = { doi, title, authors, status: "unavailable" };
      } else {
        // Inconclusive (error/timeout) — don't claim it's unavailable.
        clearBadge(tabId);
        tabState[tabId] = { doi, title, authors, status: "unknown" };
      }
      port.disconnect();
      finish();
    });

    port.onDisconnect.addListener(() => {
      // Host crashed or never responded — inconclusive, leave no badge.
      finish();
    });

    port.postMessage({ doi, action: "check", settings });
  });
}

function checkAvailability(doi, tabId, title, authors) {
  checkQueue.push({ doi, tabId, title, authors });
  runNextCheck();
}

// A real navigation to a new URL should clear any stale badge from the
// previous page. We key off changeInfo.url specifically (not status:
// "loading") because some pages flip back to "loading" for sub-resources
// or in-page activity without an actual navigation, which would otherwise
// wipe the badge right after it was set and it would never come back.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    clearBadge(tabId);
    delete lastCheckedDOI[tabId];
    delete tabState[tabId];
  }
});

function notifyDownloadResult(success, message) {
  chrome.notifications.create("doi-download-" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: success ? "Download complete" : "Download failed",
    message,
  });
}

// Shared with the popup's "Download" button logic — used by the Option+D
// shortcut so it behaves identically without needing the popup open.
function downloadDOI(doi) {
  getSettings().then((settings) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;

      if (message.status === "ok") {
        const filename = message.filepath ? message.filepath.split("/").pop() : null;
        const sizeInfo = message.size_kb ? ` (${message.size_kb} KB)` : "";
        notifyDownloadResult(true, filename ? `${filename}${sizeInfo}` : "Done");
      } else {
        notifyDownloadResult(false, message.detail || "Unknown error");
      }
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) notifyDownloadResult(false, err.message);
    });

    port.postMessage({ doi, settings });
  });
}

async function searchGoogleForTab(tab) {
  const state = tabState[tab.id];

  // Prefer freshly-scanned title/authors (works even with no DOI at all);
  // fall back to whatever we already know about this tab.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (_) {
    // Already injected or privileged page — proceed anyway.
  }

  chrome.tabs.sendMessage(tab.id, { action: "getDOI" }, (response) => {
    const title = (response && response.title) || (state && state.title) || tab.title || "";
    const authors = (response && response.authors) || (state && state.authors) || [];
    const doi = (response && response.doi) || (state && state.doi) || "";
    const query = buildSearchQuery(title, authors) || doi || title;
    if (!query) return; // Truly nothing to search for — no-op.
    chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(query) });
  });
}

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;

    if (command === "download-current") {
      const state = tabState[tab.id];
      if (state && state.status === "available") downloadDOI(state.doi);
    } else if (command === "search-google-current") {
      searchGoogleForTab(tab);
    }
  });
});

// Listen for messages from the popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "doiDetected") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    if (lastCheckedDOI[tabId] === request.doi) return;
    lastCheckedDOI[tabId] = request.doi;
    checkAvailability(request.doi, tabId, request.title, request.authors);
    return;
  }

  if (request.action === "searchAuthorWorks") {
    const { family, given } = parseAuthorName(request.author);

    // Crossref caps rows at 1000 per request — 100 was silently truncating
    // prolific authors (e.g. Nancy Fraser has 250+ exact-matching works).
    const url = "https://api.crossref.org/works?query.author=" +
      encodeURIComponent(request.author || "") + "&rows=1000&select=DOI,title,author,container-title,published-print,published-online,type,is-referenced-by-count,abstract";

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const items = (data.message && data.message.items) || [];
        const matched = items.filter((item) => matchesAuthor(item.author || [], family, given));

        // Best-effort affiliation + ORCID lookup — Crossref sometimes
        // carries the author's institution and/or ORCID iD on a given
        // paper. Take the first of each found; affiliation feeds a more
        // targeted "institutional website" search, ORCID feeds the author
        // avatar lookup (getAuthorAvatar, below).
        let affiliation = "";
        let orcid = "";
        for (const item of matched) {
          const authorEntry = (item.author || []).find((a) => matchesAuthor([a], family, given));
          if (!affiliation) {
            const aff = authorEntry && authorEntry.affiliation && authorEntry.affiliation[0];
            if (aff && aff.name) affiliation = aff.name;
          }
          if (!orcid && authorEntry && authorEntry.ORCID) {
            orcid = authorEntry.ORCID.replace(/^https?:\/\/orcid\.org\//, "");
          }
          if (affiliation && orcid) break;
        }

        const works = matched.map((item) => {
          const dateParts = (item["published-print"] || item["published-online"] || {})["date-parts"];
          const year = dateParts && dateParts[0] && dateParts[0][0];
          return {
            doi: item.DOI || null,
            title: decodeHtmlEntities((item.title && item.title[0]) || "(untitled)"),
            journal: decodeHtmlEntities((item["container-title"] && item["container-title"][0]) || ""),
            year: year || null,
            type: item.type || "",
            citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : null,
            abstract: stripJatsAbstract(item.abstract),
          };
        });
        sendResponse({ success: true, works, affiliation, orcid });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getAuthorAvatar") {
    const authorName = request.author || "";
    const orcid = request.orcid || "";

    // Same retry-once-on-429-after-2s pattern used for the Semantic Scholar
    // calls below (getCitedBy/getRelatedPapers) — applied here to every
    // remote call this handler makes (ORCID, Gravatar), not just S2.
    const fetchWithRetry = (url, options, isRetry) =>
      fetch(url, options).then((r) => {
        if (r.status === 429 && !isRetry) {
          return new Promise((resolve) => setTimeout(resolve, 2000)).then(() => fetchWithRetry(url, options, true));
        }
        return r;
      });

    chrome.storage.local.get(["authorAvatars"], (stored) => {
      const cache = stored.authorAvatars || {};
      if (cache[authorName]) {
        sendResponse({ success: true, avatar: cache[authorName] });
        return;
      }

      const cacheAndRespond = (avatar) => {
        cache[authorName] = avatar;
        chrome.storage.local.set({ authorAvatars: cache });
        sendResponse({ success: true, avatar });
      };

      // Gravatar's newer SHA-256 hashing (vs. the classic MD5 scheme) lets
      // this run on Web Crypto (crypto.subtle), available in a service
      // worker with no extra library needed. d=404 makes Gravatar return a
      // real 404 instead of a generic placeholder when the email has no
      // registered avatar, so a HEAD request cleanly tells us photo-or-not.
      const tryGravatar = (email) => {
        if (!email) {
          cacheAndRespond({ type: "initials" });
          return;
        }
        const normalized = email.trim().toLowerCase();
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)).then((buf) => {
          const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
          const url = `https://www.gravatar.com/avatar/${hash}?d=404&s=160`;
          fetchWithRetry(url, { method: "HEAD" }, false)
            .then((r) => cacheAndRespond(r.ok ? { type: "photo", url } : { type: "initials" }))
            .catch(() => cacheAndRespond({ type: "initials" }));
        });
      };

      if (!orcid) {
        cacheAndRespond({ type: "initials" });
        return;
      }

      // ORCID's public API has no photo/image field at all (checked directly
      // against the live API — its person record only has name, other-names,
      // biography, researcher-urls, emails, addresses, keywords, external-
      // identifiers). The only thing worth fetching here is a public email,
      // which we then check against Gravatar. Most ORCID profiles keep their
      // email private, so this frequently falls through to initials — that's
      // expected, not a bug.
      fetchWithRetry(
        `https://pub.orcid.org/v3.0/${encodeURIComponent(orcid)}/email`,
        { headers: { Accept: "application/json" } },
        false
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const emails = (data && data.email) || [];
          tryGravatar(emails.length > 0 ? emails[0].email : null);
        })
        .catch(() => cacheAndRespond({ type: "initials" }));
    });
    return true;
  }

  if (request.action === "getIssueInfo") {
    fetch("https://api.crossref.org/works/" + encodeURIComponent(request.doi))
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const msg = data && data.message;
        if (!msg) throw new Error("No Crossref record for this DOI");
        const issn = (msg.ISSN && msg.ISSN[0]) || null;
        const volume = msg.volume || null;
        const issue = msg.issue || null;
        const journal = decodeHtmlEntities((msg["container-title"] && msg["container-title"][0]) || "");
        const dateParts = (msg["published-print"] || msg["published-online"] || {})["date-parts"];
        const year = (dateParts && dateParts[0] && dateParts[0][0]) || null;
        if (!issn || !volume || !issue) {
          throw new Error("This paper's Crossref record is missing volume/issue/ISSN");
        }
        sendResponse({ success: true, issn, volume, issue, journal, year });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getIssueWorks") {
    // Crossref's REST API has no "volume"/"issue" filter key (that's what
    // was causing a 400 here) — narrow by publication year instead (a real
    // filter) and then match volume/issue client-side. Falls back to
    // scanning the whole journal, unfiltered, if no year is known.
    const year = request.year ? Number(request.year) : null;
    const yearFilter = year
      ? `&filter=from-pub-date:${year - 1}-01-01,until-pub-date:${year + 1}-12-31`
      : "";
    const url = `https://api.crossref.org/journals/${encodeURIComponent(request.issn)}/works` +
      `?rows=1000&select=DOI,title,author,page,is-referenced-by-count,type,volume,issue,abstract${yearFilter}`;

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const items = (data.message && data.message.items) || [];
        const matched = items.filter(
          (item) => String(item.volume) === String(request.volume) && String(item.issue) === String(request.issue)
        );
        const works = matched.map((item) => {
          const author = (item.author && item.author[0]) || null;
          const authorName = author && decodeHtmlEntities([author.given, author.family].filter(Boolean).join(" "));
          return {
            doi: item.DOI || null,
            title: decodeHtmlEntities((item.title && item.title[0]) || "(untitled)"),
            author: authorName || "",
            page: item.page || "",
            type: item.type || "",
            citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : null,
            abstract: stripJatsAbstract(item.abstract),
          };
        });
        sendResponse({ success: true, works });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getAllJournalWorks") {
    // Walks the entire journal via Crossref's cursor pagination (deep-paging
    // beyond the 1000-row single-request cap) so "Download Entire Journal"
    // doesn't need a separate lookup per volume/issue like getIssueWorks does.
    // Capped at 20 pages (~20k works) so a runaway journal can't hang forever.
    const MAX_PAGES = 20;
    (async () => {
      let cursor = "*";
      const allItems = [];
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          // No "abstract" in select here — fetching it for every work up front
          // is wasteful across a whole journal (thousands of works). Fetched
          // lazily per-article instead, via the "getWorkAbstract" action below.
          const url = `https://api.crossref.org/journals/${encodeURIComponent(request.issn)}/works` +
            `?rows=1000&cursor=${encodeURIComponent(cursor)}&select=DOI,title,author,page,is-referenced-by-count,type,volume,issue,published-print,published-online`;
          const r = await fetch(url);
          if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
          const data = await r.json();
          const msg = data.message || {};
          const items = msg.items || [];
          allItems.push(...items);

          const nextCursor = msg["next-cursor"];
          if (!nextCursor || items.length < 1000) break;
          cursor = nextCursor;
          await new Promise((resolve) => setTimeout(resolve, 300)); // stay polite to Crossref between pages
        }

        const works = allItems.map((item) => {
          const author = (item.author && item.author[0]) || null;
          const authorName = author && decodeHtmlEntities([author.given, author.family].filter(Boolean).join(" "));
          const dateParts = (item["published-print"] || item["published-online"] || {})["date-parts"];
          const year = dateParts && dateParts[0] && dateParts[0][0] ? dateParts[0][0] : null;
          return {
            doi: item.DOI || null,
            title: decodeHtmlEntities((item.title && item.title[0]) || "(untitled)"),
            author: authorName || "",
            page: item.page || "",
            type: item.type || "",
            citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : null,
            volume: item.volume || null,
            issue: item.issue || null,
            year,
          };
        });
        sendResponse({ success: true, works });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === "getWorkAbstract") {
    // OpenAlex aggregates abstracts from publishers/repositories beyond what
    // publishers bother submitting to Crossref, so it's tried first; Crossref
    // is the fallback both when OpenAlex simply doesn't have the abstract,
    // and when the OpenAlex request itself fails (network hiccup, bad JSON,
    // etc.) — a transient issue on one source shouldn't sink the whole
    // lookup, so that failure is swallowed here rather than left to the
    // outer .catch, which is reserved for the final (Crossref) attempt.
    fetch("https://api.openalex.org/works/doi:" + encodeURIComponent(request.doi))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => reconstructOpenAlexAbstract(data && data.abstract_inverted_index))
      .catch(() => null)
      .then((abstract) => {
        if (abstract) {
          sendResponse({ success: true, abstract });
          return;
        }
        return fetch("https://api.crossref.org/works/" + encodeURIComponent(request.doi))
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            const abstract = stripJatsAbstract(data && data.message && data.message.abstract);
            sendResponse({ success: true, abstract });
          });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "searchJournalKeyword") {
    // Crossref's `filter=issn:` (unlike volume/issue) is a real filter key,
    // so this can be a single targeted query instead of walking every issue
    // like getAllJournalWorks does.
    // offset (default 0) pages through results 50 at a time — the popup/page
    // side drives this with a "Load More" button rather than fetching
    // everything up front, since a broad keyword can match thousands.
    const offset = Number(request.offset) || 0;
    const url = `https://api.crossref.org/works?filter=issn:${encodeURIComponent(request.issn)}` +
      `&query=${encodeURIComponent(request.query || "")}&rows=50&offset=${offset}` +
      `&select=DOI,title,author,volume,issue,is-referenced-by-count,abstract,published-print,published-online`;

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const msg = data.message || {};
        const items = msg.items || [];
        const works = items.map((item) => {
          const author = (item.author && item.author[0]) || null;
          const authorName = author && decodeHtmlEntities([author.given, author.family].filter(Boolean).join(" "));
          const dateParts = (item["published-print"] || item["published-online"] || {})["date-parts"];
          const year = (dateParts && dateParts[0] && dateParts[0][0]) || null;
          return {
            doi: item.DOI || null,
            title: decodeHtmlEntities((item.title && item.title[0]) || "(untitled)"),
            author: authorName || "",
            volume: item.volume || null,
            issue: item.issue || null,
            year,
            citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : null,
            abstract: stripJatsAbstract(item.abstract),
          };
        });
        sendResponse({ success: true, works, totalResults: (msg["total-results"]) || works.length });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "searchBibliographic") {
    const url = "https://api.crossref.org/works?query.bibliographic=" +
      encodeURIComponent(request.query || "") +
      "&rows=30&select=DOI,title,author,container-title,published-print,published-online,type,is-referenced-by-count,abstract";

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const items = (data.message && data.message.items) || [];
        const works = items.map((item) => {
          const dateParts = (item["published-print"] || item["published-online"] || {})["date-parts"];
          const year = dateParts && dateParts[0] && dateParts[0][0];
          const author = (item.author && item.author[0]) || null;
          const authorName = author && decodeHtmlEntities([author.given, author.family].filter(Boolean).join(" "));
          return {
            doi: item.DOI || null,
            title: decodeHtmlEntities((item.title && item.title[0]) || "(untitled)"),
            journal: decodeHtmlEntities((item["container-title"] && item["container-title"][0]) || ""),
            author: authorName || "",
            year: year || null,
            type: item.type || "",
            citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : null,
            abstract: stripJatsAbstract(item.abstract),
          };
        });
        sendResponse({ success: true, works });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getWatchlist") {
    chrome.storage.sync.get({ watchlist: [] }, ({ watchlist }) => sendResponse(watchlist));
    return true;
  }

  if (request.action === "toggleWatch") {
    chrome.storage.sync.get({ watchlist: [] }, ({ watchlist }) => {
      const idx = watchlist.findIndex((w) => w.issn === request.issn);
      let watching;
      if (idx >= 0) {
        watchlist.splice(idx, 1);
        watching = false;
      } else {
        // Seed with the paper's own issue as the baseline, so the first
        // watchlist check doesn't immediately "announce" this same issue.
        watchlist.push({
          issn: request.issn,
          journal: request.journal || "",
          volume: request.volume || null,
          issue: request.issue || null,
          year: request.year || null,
        });
        watching = true;
      }
      chrome.storage.sync.set({ watchlist }, () => sendResponse({ success: true, watching }));
    });
    return true;
  }

  if (request.action === "removeWatch") {
    chrome.storage.sync.get({ watchlist: [] }, ({ watchlist }) => {
      const next = watchlist.filter((w) => w.issn !== request.issn);
      chrome.storage.sync.set({ watchlist: next }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (request.action === "checkWatchlistNow") {
    checkWatchlist().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.action === "getAuthorWatchlist") {
    chrome.storage.sync.get({ authorWatchlist: [] }, ({ authorWatchlist }) => sendResponse(authorWatchlist));
    return true;
  }

  if (request.action === "toggleAuthorWatch") {
    chrome.storage.sync.get({ authorWatchlist: [] }, ({ authorWatchlist }) => {
      const idx = authorWatchlist.findIndex((w) => w.author === request.author);
      let watching;
      if (idx >= 0) {
        authorWatchlist.splice(idx, 1);
        watching = false;
      } else {
        // Seed with no baseline yet — the next scheduled/manual check fills
        // it in without notifying, so following doesn't immediately
        // "announce" their existing latest work.
        authorWatchlist.push({ author: request.author, doi: null, title: null, year: null });
        watching = true;
      }
      chrome.storage.sync.set({ authorWatchlist }, () => sendResponse({ success: true, watching }));
    });
    return true;
  }

  if (request.action === "removeAuthorWatch") {
    chrome.storage.sync.get({ authorWatchlist: [] }, ({ authorWatchlist }) => {
      const next = authorWatchlist.filter((w) => w.author !== request.author);
      chrome.storage.sync.set({ authorWatchlist: next }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (request.action === "checkAuthorWatchlistNow") {
    checkAuthorWatchlist().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.action === "getCollaborators") {
    const { family, given } = parseAuthorName(request.author);

    // Crossref caps rows at 1000 per request — sampling the author's full
    // work list (rather than the 100-work cap used for the download list)
    // gives a fuller picture of who they actually co-author with often.
    const url = "https://api.crossref.org/works?query.author=" +
      encodeURIComponent(request.author || "") + "&rows=1000&select=DOI,author";

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const items = (data.message && data.message.items) || [];
        const matched = items.filter((item) => matchesAuthor(item.author || [], family, given));

        const counts = new Map(); // "family|given" (lowercase) -> { name, count }
        const pairCounts = new Map(); // "keyA~keyB" (sorted) -> count — how often two collaborators co-author *with each other*, for the network graph

        matched.forEach((item) => {
          // This work's collaborators (everyone except the target author),
          // keyed once so both the counts pass and the pairwise-edges pass
          // below use identical keys.
          const workAuthors = (item.author || [])
            .map((a) => {
              const f = (a.family || "").trim();
              const g = (a.given || "").trim();
              if (!f) return null;
              if (matchesAuthor([a], family, given)) return null; // skip the target author themselves
              return { key: f.toLowerCase() + "|" + g.toLowerCase(), name: decodeHtmlEntities([g, f].filter(Boolean).join(" ")) };
            })
            .filter(Boolean);

          workAuthors.forEach((a) => {
            const entry = counts.get(a.key) || { name: a.name, count: 0 };
            entry.count += 1;
            counts.set(a.key, entry);
          });

          for (let i = 0; i < workAuthors.length; i++) {
            for (let j = i + 1; j < workAuthors.length; j++) {
              const pairKey = [workAuthors[i].key, workAuthors[j].key].sort().join("~");
              pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
            }
          }
        });

        const collaborators = Array.from(counts.entries())
          .map(([key, v]) => ({ key, name: v.name, count: v.count }))
          .sort((a, b) => b.count - a.count);

        const edges = Array.from(pairCounts.entries()).map(([pairKey, count]) => {
          const [a, b] = pairKey.split("~");
          return { a, b, count };
        });

        sendResponse({ success: true, collaborators, edges, sampledWorks: matched.length });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "resolveLink") {
    getSettings().then((settings) => {
      const port = chrome.runtime.connectNative(NATIVE_HOST);

      port.onMessage.addListener((message) => {
        if (message.type === "progress") return;
        sendResponse({ success: true, result: message });
        port.disconnect();
      });

      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (err) sendResponse({ success: false, error: err.message });
      });

      port.postMessage({ doi: request.doi, action: "check", settings });
    });
    return true;
  }

  if (request.action === "getTabState") {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    sendResponse(tabState[tabId] || null);
    return;
  }

  if (request.action === "getReferences") {
    fetch("https://api.crossref.org/works/" + encodeURIComponent(request.doi))
      .then((r) => {
        if (!r.ok) throw new Error("Crossref lookup failed (" + r.status + ")");
        return r.json();
      })
      .then((data) => {
        const refs = (data.message && data.message.reference) || [];
        return refs.filter((r) => r.DOI).map((r) => ({
          doi: r.DOI,
          title: decodeHtmlEntities(r["article-title"] || r.unstructured || "") || null,
        }));
      })
      .then((withDOI) => {
        // Many publishers only assert the reference's DOI, with no title —
        // fetch each of those individually to fill in a real title/author.
        // Crossref rate-limits bursts, so these are throttled (3 at a time,
        // one retry on failure) rather than fired all at once — a bare
        // `Promise.all` here was silently losing a few to 429s.
        const needsFetch = withDOI.filter((ref) => !ref.title);
        const CONCURRENCY = 3;
        let cursor = 0;

        const fetchOne = (ref, isRetry) =>
          fetch("https://api.crossref.org/works/" + encodeURIComponent(ref.doi))
            .then((r) => {
              if (!r.ok) throw new Error("status " + r.status);
              return r.json();
            })
            .then((data) => {
              const msg = data && data.message;
              const title = msg && msg.title && msg.title[0];
              const author = msg && msg.author && msg.author[0];
              const authorName = author && (author.family || author.name);
              ref.title = title
                ? (authorName ? `${title} — ${authorName}` : title)
                : ref.doi;
            })
            .catch((err) => {
              if (!isRetry) return fetchOne(ref, true);
              ref.title = ref.doi;
            });

        const worker = () => {
          if (cursor >= needsFetch.length) return Promise.resolve();
          const ref = needsFetch[cursor];
          cursor += 1;
          return fetchOne(ref, false).then(worker);
        };

        const workers = new Array(Math.min(CONCURRENCY, needsFetch.length)).fill(0).map(worker);
        return Promise.all(workers).then(() => withDOI);
      })
      .then((references) => {
        sendResponse({ success: true, references });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getCitedBy") {
    // "authors.name" isn't a recognized field on this endpoint (S2 returns
    // a 400 for it on every request) — plain "authors" returns each
    // citingPaper's full {authorId, name} objects instead.
    const url = "https://api.semanticscholar.org/graph/v1/paper/DOI:" + encodeURIComponent(request.doi) +
      "/citations?fields=title,externalIds,authors,year&limit=100";

    // Semantic Scholar's unauthenticated tier rate-limits aggressively —
    // one retry after a short wait on a 429 before giving up, same pattern
    // as the Crossref reference-title backfill above.
    const fetchWithRetry = (isRetry) =>
      fetch(url).then((r) => {
        if (r.status === 429 && !isRetry) {
          return new Promise((resolve) => setTimeout(resolve, 2000)).then(() => fetchWithRetry(true));
        }
        if (!r.ok) throw new Error("Semantic Scholar lookup failed (" + r.status + ")");
        return r.json();
      });

    fetchWithRetry(false)
      .then((data) => {
        const citations = (data && data.data) || [];
        const citedBy = citations
          .map((c) => c.citingPaper)
          .filter((p) => p && p.externalIds && p.externalIds.DOI)
          .map((p) => ({
            doi: p.externalIds.DOI,
            title: p.title || p.externalIds.DOI,
            year: p.year || null,
            author: (p.authors && p.authors[0] && p.authors[0].name) || "",
          }));
        sendResponse({ success: true, citedBy });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getRelatedPapers") {
    // "Related by citation" rather than keyword-similarity (search.html's
    // Find Similar) — uses Semantic Scholar's Recommendations API,
    // which is built on their own citation graph (effectively co-citation:
    // papers that tend to get cited alongside this one), instead of
    // reimplementing that analysis client-side by walking references/
    // citations ourselves, which would mean many more API calls against an
    // aggressively rate-limited unauthenticated tier for a worse result.
    const url = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper/DOI:" +
      encodeURIComponent(request.doi) + "?fields=title,externalIds,authors,year&limit=20";

    const fetchWithRetry = (isRetry) =>
      fetch(url).then((r) => {
        if (r.status === 429 && !isRetry) {
          return new Promise((resolve) => setTimeout(resolve, 2000)).then(() => fetchWithRetry(true));
        }
        if (!r.ok) throw new Error("Semantic Scholar lookup failed (" + r.status + ")");
        return r.json();
      });

    fetchWithRetry(false)
      .then((data) => {
        const recs = (data && data.recommendedPapers) || [];
        const related = recs
          .filter((p) => p && p.externalIds && p.externalIds.DOI)
          .map((p) => ({
            doi: p.externalIds.DOI,
            title: p.title || p.externalIds.DOI,
            year: p.year || null,
            author: (p.authors && p.authors[0] && p.authors[0].name) || "",
          }));
        sendResponse({ success: true, related });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "getSciHubUrl") {
    getSettings().then((settings) => {
      const mirror = (settings.mirrors && settings.mirrors[0]) || "https://sci-hub.se";
      const url = mirror.replace(/\/+$/, "") + "/" + request.doi;
      sendResponse({ url });
    });
    return true;
  }

  if (request.action === "openSciHubPage") {
    getSettings().then((settings) => {
      const mirror = (settings.mirrors && settings.mirrors[0]) || "https://sci-hub.se";
      const url = mirror.replace(/\/+$/, "") + "/" + request.doi;
      // Background tab — a foreground one steals focus and closes the
      // popup, which is annoying when clicking through a references list.
      chrome.tabs.create({ url, active: false });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === "getDownloadStats") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", counts: message.counts, error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "download_stats" });
    return true;
  }

  if (request.action === "getPaperOfTheDay") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    const nativeResult = new Promise((resolve, reject) => {
      port.onMessage.addListener((message) => {
        if (message.type === "progress") return;
        resolve(message);
        port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
      });
    });

    port.postMessage({ action: "recent_downloads", limit: 50 });

    nativeResult
      .then((message) => {
        if (message.status !== "ok") throw new Error(message.detail || "Couldn't read the download log");
        const downloads = message.downloads || [];
        if (downloads.length === 0) throw new Error("No downloads yet");

        const today = new Date().toISOString().slice(0, 10);

        return new Promise((resolve) => {
          chrome.storage.local.get({ potdNonce: null }, ({ potdNonce }) => {
            // Deterministic per (day, nonce) pair — same pick all day unless
            // the user clicks Refresh, which bumps the nonce and is itself
            // deterministic (so a second Refresh click after an identical
            // state still advances rather than looping back).
            let nonce = potdNonce && potdNonce.date === today ? potdNonce.nonce : 0;
            if (request.refresh) nonce += 1;

            const seed = `${today}|${nonce}`;
            let hash = 0;
            for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
            const pick = downloads[hash % downloads.length];

            if (request.refresh) {
              chrome.storage.local.set({ potdNonce: { date: today, nonce } });
            }

            resolve(pick);
          });
        });
      })
      .then((pick) =>
        getSettings().then((settings) => {
          const mirror = (settings.mirrors && settings.mirrors[0]) || "https://sci-hub.se";
          const url = mirror.replace(/\/+$/, "") + "/" + pick.doi;

          return fetch("https://api.crossref.org/works/" + encodeURIComponent(pick.doi))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              const msg = data && data.message;
              const title = decodeHtmlEntities((msg && msg.title && msg.title[0]) || "") || pick.doi;
              const abstract = stripJatsAbstract(msg && msg.abstract);
              return { doi: pick.doi, title, url, abstract };
            })
            .catch(() => {
              // Crossref being unreachable shouldn't sink the whole feature —
              // fall back to showing the bare DOI as the title.
              return { doi: pick.doi, title: pick.doi, url, abstract: null };
            });
        })
      )
      .then((result) => {
        const today = new Date().toISOString().slice(0, 10);
        chrome.storage.local.get({ potdHistory: [] }, ({ potdHistory }) => {
          // Skip logging a duplicate if it's literally the same pick as last
          // time (e.g. Settings just reopened without a Refresh click) —
          // only a genuinely new pick counts as a new history entry.
          const last = potdHistory[0];
          if (!last || last.doi !== result.doi) {
            // Skip the abstract in history — the list only ever shows date +
            // title, no need to carry that extra weight across 50 entries.
            potdHistory = [{ date: today, doi: result.doi, title: result.title, url: result.url }, ...potdHistory].slice(0, 50);
            chrome.storage.local.set({ potdHistory });
          }
          sendResponse({ success: true, ...result });
        });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }

  if (request.action === "getPaperOfTheDayHistory") {
    chrome.storage.local.get({ potdHistory: [] }, ({ potdHistory }) => {
      sendResponse({ success: true, history: potdHistory });
    });
    return true;
  }

  if (request.action === "getDefaultOutputDir") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", path: message.path, error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "default_output_dir" });
    return true;
  }

  if (request.action === "getMirrorHealth") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", mirrors: message.mirrors, error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "mirror_health" });
    return true;
  }

  if (request.action === "resetMirrorHealth") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "reset_mirror_health", url: request.url });
    return true;
  }

  if (request.action === "checkForUpdate") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({
        success: message.status === "ok",
        behindBy: message.behind_by,
        commits: message.commits,
        localSha: message.local_sha,
        error: message.detail,
      });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "check_for_update" });
    return true;
  }

  if (request.action === "applyUpdate") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({
        success: message.status === "ok",
        output: message.output,
        nativeHostChanged: message.native_host_changed,
        error: message.detail,
      });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "apply_update" });
    return true;
  }

  if (request.action === "exportBackupData") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({
        success: message.status === "ok",
        downloadLog: message.download_log,
        mirrorHealth: message.mirror_health,
        error: message.detail,
      });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "export_data" });
    return true;
  }

  if (request.action === "openFolder") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "open_folder", folder: request.folder });
    return true;
  }

  if (request.action === "readLog") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", content: message.content, error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "read_log", filepath: request.filepath });
    return true;
  }

  if (request.action === "appendLog") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "append_log", filepath: request.filepath, line: request.line });
    return true;
  }

  if (request.action === "deleteFile") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "delete_file", filepath: request.filepath });
    return true;
  }

  if (request.action === "revealFile") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      if (message.type === "progress") return;
      sendResponse({ success: message.status === "ok", error: message.detail });
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) sendResponse({ success: false, error: err.message });
    });

    port.postMessage({ action: "reveal", filepath: request.filepath });
    return true;
  }

  if (request.action === "sendDOI") {
    getSettings().then((settings) => {
      const port = chrome.runtime.connectNative(NATIVE_HOST);

      // Batch features (e.g. "Download All Works") pass an outputDirOverride
      // to save into a dedicated subfolder without touching the user's
      // configured default output directory.
      const effectiveSettings = request.outputDirOverride
        ? { ...settings, outputDir: request.outputDirOverride }
        : settings;

      port.onMessage.addListener((message) => {
        if (message.type === "progress") {
          // Forward live progress lines to any open popup. No popup being
          // open is the common case (most downloads run in the background),
          // so read lastError in the callback to swallow the resulting
          // harmless "receiving end does not exist" rather than logging it.
          chrome.runtime.sendMessage({ action: "progress", line: message.line }, () => void chrome.runtime.lastError);
          return;
        }

        // Final result
        sendResponse({ success: true, result: message });
        port.disconnect();
      });

      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error("Native messaging error:", err.message);
          sendResponse({ success: false, error: err.message });
        }
      });

      port.postMessage({ doi: request.doi, settings: effectiveSettings });
    });

    // Keep the message channel open until sendResponse is called
    return true;
  }
});
