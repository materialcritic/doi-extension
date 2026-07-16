const doiBox    = document.getElementById("doi-box");
const btnRun    = document.getElementById("btn-run");
const btnCopy   = document.getElementById("btn-copy");
const btnLink   = document.getElementById("btn-link");
const btnView   = document.getElementById("btn-view");
const btnSagePdf = document.getElementById("btn-sage-pdf");
const btnReveal = document.getElementById("btn-reveal");
const btnDeleteCorrupt = document.getElementById("btn-delete-corrupt");
const btnSearch = document.getElementById("btn-search");
const btnAuthor = document.getElementById("btn-author");
const btnDownloadAll = document.getElementById("btn-download-all");
const btnCollaborators = document.getElementById("btn-collaborators");
const btnQR = document.getElementById("btn-qr");
const qrPanel = document.getElementById("qr-panel");
const qrCodeEl = document.getElementById("qr-code");
const btnReferences = document.getElementById("btn-references");
const referencesPanel = document.getElementById("references-panel");
const referencesList = document.getElementById("references-list");
const btnCitedBy = document.getElementById("btn-cited-by");
const citedByPanel = document.getElementById("cited-by-panel");
const citedByList = document.getElementById("cited-by-list");
const btnRelated = document.getElementById("btn-related");
const relatedPanel = document.getElementById("related-panel");
const relatedList = document.getElementById("related-list");
const btnIssue = document.getElementById("btn-issue");
const statusEl  = document.getElementById("status");
const logEl     = document.getElementById("log");
const statusBanner = document.getElementById("status-banner");
const statusRing = document.getElementById("status-ring");
const statusRingIcon = document.getElementById("status-ring-icon");
const statusHeadline = document.getElementById("status-headline");
const bannerCopyLink = document.getElementById("banner-copy-link");

let currentDOI = null;
let currentTitle = "";
let currentAuthors = [];
let lastFilepath = null;
let currentTabId = null;
let corruptFilepath = null;
let currentSciHubUrl = null;
let cachedReferences = null;
let cachedCitedBy = null;
let cachedRelated = null;
let currentIssueInfo = null;

// Shared shimmer placeholder for the References/Cited-By/Related panels — rarely
// seen in practice since both are prefetched the moment a DOI is detected,
// but shown if the popup opens before that prefetch has landed.
function skeletonRefRowsHtml() {
  return Array.from({ length: 3 })
    .map(
      () => `<div class="skeleton-ref-row"><div class="skeleton-bar" style="width: 90%;"></div></div>`
    )
    .join("");
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function clearLog() {
  logEl.textContent = "";
  logEl.classList.remove("visible");
}

function appendLog(line, isError = false) {
  logEl.classList.add("visible");
  const div = document.createElement("div");
  if (isError) div.className = "err-line";
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// Sage (journals.sagepub.com) DOIs all carry the 10.1177 registrant prefix,
// and expose PDFs at a predictable URL — .../doi/<DOI> with "/pdf/" inserted
// after "/doi/". Sage's site is behind a Cloudflare bot-challenge that blocks
// any server-side fetch (confirmed directly against the live URL), so this
// can't be verified via the native host the way Sci-Hub/Unpaywall/publisher
// checks are — it's only offered as a manual open-in-a-real-tab link, shown
// once Sci-Hub/OA have both come back negative for a Sage DOI.
function isSageDOI(doi) {
  return !!doi && doi.startsWith("10.1177/");
}

function sagePdfUrl(doi) {
  return `https://journals.sagepub.com/doi/pdf/${doi}`;
}

// Reflects the same available/unavailable/unknown tri-state already used to
// enable btnView and show btnSagePdf onto the status banner's ring + headline.
function setAvailabilityUI(status) {
  statusRing.classList.remove("ok", "err");
  if (status === "available") {
    statusRing.classList.add("ok");
    statusRingIcon.textContent = "✓";
    statusHeadline.textContent = "Available on Sci-Hub";
  } else if (status === "unavailable") {
    statusRing.classList.add("err");
    statusRingIcon.textContent = "✕";
    statusHeadline.textContent = "Not available on Sci-Hub";
  } else {
    statusRingIcon.textContent = "…";
    statusHeadline.textContent = "Checking availability…";
  }
}

function refreshViewButton() {
  if (!currentDOI || currentTabId == null) {
    btnView.disabled = true;
    btnSagePdf.classList.remove("visible");
    setAvailabilityUI(null);
    return;
  }
  chrome.runtime.sendMessage({ action: "getTabState", tabId: currentTabId }, (state) => {
    btnView.disabled = !state || state.status !== "available";
    const showSage = !!state && state.status === "unavailable" && isSageDOI(currentDOI);
    btnSagePdf.classList.toggle("visible", showSage);
    setAvailabilityUI(state ? state.status : null);
  });
}

function showDOI(doi) {
  currentDOI = doi;
  doiBox.textContent = doi;
  doiBox.className = "";
  statusBanner.classList.remove("collapsed");
  btnRun.disabled = false;
  btnCopy.disabled = false;
  btnLink.disabled = false;
  btnSearch.disabled = false;
  btnQR.disabled = false;
  qrPanel.classList.remove("visible");
  btnSagePdf.classList.remove("visible");
  btnReferences.disabled = false;
  referencesPanel.classList.remove("visible");
  referencesList.innerHTML = "";
  btnCitedBy.disabled = false;
  citedByPanel.classList.remove("visible");
  citedByList.innerHTML = "";
  btnRelated.disabled = false;
  relatedPanel.classList.remove("visible");
  relatedList.innerHTML = "";
  refreshViewButton();

  currentSciHubUrl = null;
  chrome.runtime.sendMessage({ action: "getSciHubUrl", doi: doi }, (resp) => {
    currentSciHubUrl = (resp && resp.url) || "https://doi.org/" + doi;
  });

  // Prefetch references in the background so the panel opens instantly
  // once the user clicks "References" instead of loading on demand.
  cachedReferences = null;
  chrome.runtime.sendMessage({ action: "getReferences", doi: doi }, (resp) => {
    if (currentDOI !== doi) return; // popup moved on to a different page
    cachedReferences = resp;
  });

  // Prefetch citing papers the same way, so the "Cited By" panel opens
  // instantly too.
  cachedCitedBy = null;
  chrome.runtime.sendMessage({ action: "getCitedBy", doi: doi }, (resp) => {
    if (currentDOI !== doi) return; // popup moved on to a different page
    cachedCitedBy = resp;
  });

  // Prefetch citation-graph-related papers the same way, so the "Related
  // Papers" panel opens instantly too.
  cachedRelated = null;
  chrome.runtime.sendMessage({ action: "getRelatedPapers", doi: doi }, (resp) => {
    if (currentDOI !== doi) return; // popup moved on to a different page
    cachedRelated = resp;
  });

  // Prefetch the paper's volume/issue/ISSN so "Download This Issue" can
  // enable itself only when Crossref actually has that info.
  currentIssueInfo = null;
  btnIssue.disabled = true;
  chrome.runtime.sendMessage({ action: "getIssueInfo", doi: doi }, (resp) => {
    if (currentDOI !== doi) return; // popup moved on to a different page
    if (resp && resp.success) {
      currentIssueInfo = resp;
      btnIssue.disabled = false;
    }
  });
}

function showEmpty() {
  doiBox.textContent = "No DOI found on this page.";
  doiBox.className = "empty";
  statusBanner.classList.add("collapsed");
  btnRun.disabled = true;
  btnCopy.disabled = true;
  btnLink.disabled = true;
  btnView.disabled = true;
  btnQR.disabled = true;
  qrPanel.classList.remove("visible");
  btnReferences.disabled = true;
  referencesPanel.classList.remove("visible");
  btnCitedBy.disabled = true;
  citedByPanel.classList.remove("visible");
  btnRelated.disabled = true;
  relatedPanel.classList.remove("visible");
  btnIssue.disabled = true;
  btnSearch.disabled = currentAuthors.length === 0 && !currentTitle;
}

function showError(msg) {
  doiBox.textContent = msg;
  doiBox.className = "error";
  statusBanner.classList.add("collapsed");
  btnRun.disabled = true;
  btnCopy.disabled = true;
  btnLink.disabled = true;
  btnView.disabled = true;
  btnQR.disabled = true;
  qrPanel.classList.remove("visible");
  btnReferences.disabled = true;
  referencesPanel.classList.remove("visible");
  btnCitedBy.disabled = true;
  citedByPanel.classList.remove("visible");
  btnRelated.disabled = true;
  relatedPanel.classList.remove("visible");
  btnIssue.disabled = true;
  btnSearch.disabled = true;
}

// Inject content script and ask it to find the DOI
async function scanPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  // Inject content script (handles cases where it wasn't auto-injected)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (_) {
    // Already injected or privileged page — proceed anyway
  }

  chrome.tabs.sendMessage(tab.id, { action: "getDOI" }, (response) => {
    if (chrome.runtime.lastError) {
      showError("Can't access this page.");
      return;
    }
    currentTitle = response?.title || "";
    currentAuthors = response?.authors || [];
    btnAuthor.disabled = currentAuthors.length === 0;
    btnDownloadAll.disabled = currentAuthors.length === 0;
    btnCollaborators.disabled = currentAuthors.length === 0;
    if (response && response.doi) {
      showDOI(response.doi);
    } else {
      showEmpty();
    }
  });
}

// Live progress lines forwarded from background.js while the script runs
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress") {
    appendLog(message.line);
  }
});

btnRun.addEventListener("click", () => {
  if (!currentDOI) return;
  clearLog();
  setStatus("Downloading…");
  btnRun.disabled = true;
  lastFilepath = null;
  corruptFilepath = null;
  btnReveal.classList.remove("visible");
  btnDeleteCorrupt.classList.remove("visible");

  chrome.runtime.sendMessage({ action: "sendDOI", doi: currentDOI }, (resp) => {
    btnRun.disabled = false;

    if (!resp || !resp.success) {
      const msg = resp?.error || "Unknown error";
      setStatus("Failed: " + msg, "err");
      appendLog(msg, true);
      return;
    }

    const result = resp.result || {};
    if (result.status === "ok") {
      const filename = result.filepath ? result.filepath.split("/").pop() : null;
      const sizeInfo = result.size_kb ? ` (${result.size_kb} KB)` : "";
      const oaInfo = result.source === "open_access" ? " (open access)" : "";
      setStatus(filename ? `Downloaded: ${filename}${sizeInfo}${oaInfo}` : `Done ✓${oaInfo}`, "ok");
      if (result.filepath) {
        lastFilepath = result.filepath;
        btnReveal.classList.add("visible");
      }
    } else if (result.status === "corrupt") {
      const filename = result.filepath ? result.filepath.split("/").pop() : null;
      setStatus(`Not a valid PDF${filename ? ": " + filename : ""} — mirror likely served an error page`, "err");
      if (result.filepath) {
        corruptFilepath = result.filepath;
        btnDeleteCorrupt.classList.add("visible");
      }
    } else {
      setStatus("Failed: " + (result.detail || "Unknown error"), "err");
      if (result.detail) appendLog(result.detail, true);
    }
  });
});

btnReveal.addEventListener("click", () => {
  if (!lastFilepath) return;
  btnReveal.disabled = true;
  setStatus("Locating file… (may take a few seconds if it's still being renamed)");

  chrome.runtime.sendMessage({ action: "revealFile", filepath: lastFilepath }, (resp) => {
    btnReveal.disabled = false;
    if (!resp || !resp.success) {
      setStatus("Couldn't open Finder: " + (resp?.error || "Unknown error"), "err");
    } else {
      setStatus("Revealed in Finder ✓", "ok");
    }
  });
});

document.getElementById("btn-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  window.toggleTheme();
});

btnCopy.addEventListener("click", () => {
  if (!currentDOI) return;
  navigator.clipboard.writeText(currentDOI).then(() => {
    setStatus("Copied to clipboard ✓", "ok");
  });
});

btnLink.addEventListener("click", () => {
  if (!currentDOI) return;
  setStatus("Resolving link…");
  btnLink.disabled = true;

  chrome.runtime.sendMessage({ action: "resolveLink", doi: currentDOI }, (resp) => {
    btnLink.disabled = false;

    if (!resp || !resp.success) {
      setStatus("Failed: " + (resp?.error || "Unknown error"), "err");
      return;
    }

    const result = resp.result || {};
    if (result.status === "available" && result.pdf_url) {
      navigator.clipboard.writeText(result.pdf_url).then(() => {
        setStatus("Link copied ✓", "ok");
      });
    } else if (result.status === "unavailable") {
      setStatus("Not available on Sci-Hub", "err");
    } else {
      setStatus("Failed: " + (result.detail || "Unknown error"), "err");
    }
  });
});

btnDeleteCorrupt.addEventListener("click", () => {
  if (!corruptFilepath) return;
  btnDeleteCorrupt.disabled = true;

  chrome.runtime.sendMessage({ action: "deleteFile", filepath: corruptFilepath }, (resp) => {
    btnDeleteCorrupt.disabled = false;
    if (!resp || !resp.success) {
      setStatus("Couldn't delete file: " + (resp?.error || "Unknown error"), "err");
      return;
    }
    setStatus("Deleted ✓", "ok");
    corruptFilepath = null;
    btnDeleteCorrupt.classList.remove("visible");
  });
});

btnView.addEventListener("click", () => {
  if (!currentDOI) return;
  chrome.runtime.sendMessage({ action: "openSciHubPage", doi: currentDOI });
});

btnSagePdf.addEventListener("click", () => {
  if (!currentDOI) return;
  chrome.tabs.create({ url: sagePdfUrl(currentDOI), active: false });
});

btnQR.addEventListener("click", () => {
  if (!currentDOI) return;

  if (qrPanel.classList.contains("visible")) {
    qrPanel.classList.remove("visible");
    return;
  }

  const url = currentSciHubUrl || "https://doi.org/" + currentDOI;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  qrCodeEl.innerHTML = qr.createSvgTag(4, 8);
  qrPanel.classList.add("visible");
});

function renderReferences(resp) {
  if (!resp || !resp.success) {
    referencesList.innerHTML = `<div class="hint" style="padding: 6px 0;">Couldn't load references: ${resp?.error || "Unknown error"}</div>`;
    return;
  }

  if (resp.references.length === 0) {
    referencesList.innerHTML = '<div class="hint" style="padding: 6px 0;">No references with DOIs found for this paper.</div>';
    return;
  }

  referencesList.innerHTML = "";
  resp.references.forEach((ref) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.title = ref.doi;
    row.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openDoiPage", doi: ref.doi });
    });

    const title = document.createElement("div");
    title.className = "ref-title";
    title.textContent = ref.title;

    const open = document.createElement("span");
    open.className = "ref-open";
    open.textContent = "↗";

    row.appendChild(title);
    row.appendChild(open);
    referencesList.appendChild(row);
  });
}

btnReferences.addEventListener("click", () => {
  if (!currentDOI) return;

  if (referencesPanel.classList.contains("visible")) {
    referencesPanel.classList.remove("visible");
    return;
  }

  referencesPanel.classList.add("visible");

  if (cachedReferences) {
    renderReferences(cachedReferences);
    return;
  }

  referencesList.innerHTML = skeletonRefRowsHtml();
  const doiAtClick = currentDOI;
  let ticks = 0;
  const waitForCache = setInterval(() => {
    ticks += 1;
    if (currentDOI !== doiAtClick || ticks > 75) {
      // Popup navigated to a different page, or the prefetch never
      // resolved (e.g. errored without calling the sendMessage callback)
      // — stop polling instead of spinning forever.
      clearInterval(waitForCache);
      return;
    }
    if (cachedReferences) {
      clearInterval(waitForCache);
      renderReferences(cachedReferences);
    }
  }, 200);
});

function renderCitedBy(resp) {
  if (!resp || !resp.success) {
    citedByList.innerHTML = `<div class="hint" style="padding: 6px 0;">Couldn't load citing papers: ${resp?.error || "Unknown error"}</div>`;
    return;
  }

  if (resp.citedBy.length === 0) {
    citedByList.innerHTML = '<div class="hint" style="padding: 6px 0;">No citing papers with DOIs found (via Semantic Scholar).</div>';
    return;
  }

  citedByList.innerHTML = "";
  resp.citedBy.forEach((cite) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.title = cite.doi;
    row.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openDoiPage", doi: cite.doi });
    });

    const title = document.createElement("div");
    title.className = "ref-title";
    const metaBits = [cite.author, cite.year].filter(Boolean).join(", ");
    title.textContent = metaBits ? `${cite.title} (${metaBits})` : cite.title;

    const open = document.createElement("span");
    open.className = "ref-open";
    open.textContent = "↗";

    row.appendChild(title);
    row.appendChild(open);
    citedByList.appendChild(row);
  });
}

btnCitedBy.addEventListener("click", () => {
  if (!currentDOI) return;

  if (citedByPanel.classList.contains("visible")) {
    citedByPanel.classList.remove("visible");
    return;
  }

  citedByPanel.classList.add("visible");

  if (cachedCitedBy) {
    renderCitedBy(cachedCitedBy);
    return;
  }

  citedByList.innerHTML = skeletonRefRowsHtml();
  const doiAtClick = currentDOI;
  let ticks = 0;
  const waitForCache = setInterval(() => {
    ticks += 1;
    if (currentDOI !== doiAtClick || ticks > 75) {
      clearInterval(waitForCache);
      return;
    }
    if (cachedCitedBy) {
      clearInterval(waitForCache);
      renderCitedBy(cachedCitedBy);
    }
  }, 200);
});

function renderRelated(resp) {
  if (!resp || !resp.success) {
    relatedList.innerHTML = `<div class="hint" style="padding: 6px 0;">Couldn't load related papers: ${resp?.error || "Unknown error"}</div>`;
    return;
  }

  if (resp.related.length === 0) {
    relatedList.innerHTML = '<div class="hint" style="padding: 6px 0;">No citation-graph-related papers found (via Semantic Scholar).</div>';
    return;
  }

  relatedList.innerHTML = "";
  resp.related.forEach((rel) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.title = rel.doi;
    row.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openDoiPage", doi: rel.doi });
    });

    const title = document.createElement("div");
    title.className = "ref-title";
    const metaBits = [rel.author, rel.year].filter(Boolean).join(", ");
    title.textContent = metaBits ? `${rel.title} (${metaBits})` : rel.title;

    const open = document.createElement("span");
    open.className = "ref-open";
    open.textContent = "↗";

    row.appendChild(title);
    row.appendChild(open);
    relatedList.appendChild(row);
  });
}

btnRelated.addEventListener("click", () => {
  if (!currentDOI) return;

  if (relatedPanel.classList.contains("visible")) {
    relatedPanel.classList.remove("visible");
    return;
  }

  relatedPanel.classList.add("visible");

  if (cachedRelated) {
    renderRelated(cachedRelated);
    return;
  }

  relatedList.innerHTML = skeletonRefRowsHtml();
  const doiAtClick = currentDOI;
  let ticks = 0;
  const waitForCache = setInterval(() => {
    ticks += 1;
    if (currentDOI !== doiAtClick || ticks > 75) {
      clearInterval(waitForCache);
      return;
    }
    if (cachedRelated) {
      clearInterval(waitForCache);
      renderRelated(cachedRelated);
    }
  }, 200);
});

btnSearch.addEventListener("click", () => {
  const query = [currentTitle, currentAuthors[0]].filter(Boolean).join(" ");
  const url = "https://www.google.com/search?q=" + encodeURIComponent(query || currentDOI || "");
  chrome.tabs.create({ url });
});

btnAuthor.addEventListener("click", () => {
  if (!currentAuthors.length) return;
  const url = "https://scholar.google.com/scholar?q=" + encodeURIComponent(`"${currentAuthors[0]}"`);
  chrome.tabs.create({ url });
});

btnDownloadAll.addEventListener("click", () => {
  if (!currentAuthors.length) return;
  const url = chrome.runtime.getURL("author.html") + "?author=" + encodeURIComponent(currentAuthors[0]);
  chrome.tabs.create({ url });
});

btnCollaborators.addEventListener("click", () => {
  if (!currentAuthors.length) return;
  const url = chrome.runtime.getURL("collaborators.html") + "?author=" + encodeURIComponent(currentAuthors[0]);
  chrome.tabs.create({ url });
});

btnIssue.addEventListener("click", () => {
  if (!currentIssueInfo) return;
  const params = new URLSearchParams({
    issn: currentIssueInfo.issn,
    volume: currentIssueInfo.volume,
    issue: currentIssueInfo.issue,
    journal: currentIssueInfo.journal || "",
    year: currentIssueInfo.year || "",
  });
  const url = chrome.runtime.getURL("issue.html") + "?" + params.toString();
  chrome.tabs.create({ url });
});

// Single-key popup shortcuts (Settings → Popup Shortcuts), separate from
// the page-wide Alt+D/Alt+F chrome.commands shortcuts. Cached and refreshed
// on storage changes so every keystroke doesn't need a storage round trip.
let popupShortcutMap = {};

function reloadPopupShortcuts() {
  getPopupShortcutMap((map) => { popupShortcutMap = map; });
}

reloadPopupShortcuts();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.popupShortcuts) reloadPopupShortcuts();
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key.toLowerCase();
  const action = POPUP_SHORTCUT_ACTIONS.find((a) => popupShortcutMap[a.id] === key);
  if (!action) return;

  const btn = document.getElementById(action.btnId);
  if (btn && !btn.disabled) {
    e.preventDefault();
    btn.click();
  }
});

// Lightweight "Update available" hint — reads the cache background.js keeps
// fresh via a 12-hour alarm rather than doing its own native-messaging round
// trip on every popup open. Clicking opens Settings' Updates card.
const updateHintEl = document.getElementById("update-hint");
chrome.storage.local.get(["updateInfo"], ({ updateInfo }) => {
  if (updateInfo && updateInfo.behindBy > 0) {
    updateHintEl.textContent =
      updateInfo.behindBy === 1 ? "Update available" : `Update available (${updateInfo.behindBy} changes)`;
    updateHintEl.classList.add("visible");
  }
});
updateHintEl.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + "#updates" });
});

// Actions / Explore tab switching (popup-only, no dependency on background.js)
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add("active");
  });
});

// Status banner's quick link just proxies to the real "Copy Sci-Hub Link"
// row so there's one source of truth for the resolve-and-copy logic; clicking
// while btnLink is disabled (no DOI, or a resolve already in flight) is a
// no-op since disabled buttons don't dispatch click via .click().
bannerCopyLink.addEventListener("click", () => btnLink.click());

// Run on popup open
scanPage();
