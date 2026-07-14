const issueTitleEl = document.getElementById("issue-title");
const subtitleEl = document.getElementById("subtitle");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("list");
const statusLineEl = document.getElementById("status-line");
const btnSelectAll = document.getElementById("btn-select-all");
const btnSelectNone = document.getElementById("btn-select-none");
const btnDownload = document.getElementById("btn-download");
const btnRetryFailed = document.getElementById("btn-retry-failed");
const btnOpenFolder = document.getElementById("btn-open-folder");
const searchInput = document.getElementById("search-input");
const noMatchesEl = document.getElementById("no-matches");
const progressBarWrap = document.getElementById("progress-bar-wrap");
const progressBar = document.getElementById("progress-bar");
const abstractTooltipEl = document.getElementById("abstract-tooltip");
const btnWatch = document.getElementById("btn-watch");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Wraps whole-word (unicode-aware) matches of any search term in <mark>,
// case-insensitively. Used for Search This Journal results, where seeing
// *why* something matched matters more than for the plain issue list.
function highlightTerms(text, terms) {
  const escaped = escapeHtml(text);
  if (!terms || terms.length === 0) return escaped;

  const pattern = terms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return escaped;

  return escaped.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

// Positions near the cursor but nudged to stay on-screen, since the tooltip's
// width isn't known until its text is set. highlightQuery (optional) bolds
// matched search terms instead of showing plain text.
function showAbstractTooltip(text, x, y, highlightQuery) {
  if (highlightQuery) {
    abstractTooltipEl.innerHTML = highlightTerms(text, highlightQuery.split(/\s+/));
  } else {
    abstractTooltipEl.textContent = text;
  }
  abstractTooltipEl.style.display = "block";
  const maxLeft = window.innerWidth - abstractTooltipEl.offsetWidth - 16;
  const maxTop = window.innerHeight - abstractTooltipEl.offsetHeight - 16;
  abstractTooltipEl.style.left = Math.max(8, Math.min(x + 14, maxLeft)) + "px";
  abstractTooltipEl.style.top = Math.max(8, Math.min(y + 14, maxTop)) + "px";
}

function hideAbstractTooltip() {
  abstractTooltipEl.style.display = "none";
}

// Crude but cheap "find similar" — take the abstract's most frequent
// non-trivial words and hand them to Crossref's bibliographic search rather
// than doing any real NLP.
const STOPWORDS = new Set([
  "the", "and", "of", "in", "to", "a", "is", "that", "this", "for", "are", "on", "with", "as", "by",
  "an", "be", "was", "were", "or", "from", "its", "it", "which", "these", "those", "we", "our",
  "their", "have", "has", "had", "not", "but", "between", "can", "also", "such", "than", "other",
  "more", "most", "however", "study", "paper", "article", "results", "using", "based", "within",
  "among", "both", "each", "been", "into", "when", "while", "then", "than", "them", "they", "there",
]);

function extractKeywords(text, n = 6) {
  const counts = new Map();
  (text.toLowerCase().match(/[a-z]{4,}/g) || []).forEach((w) => {
    if (STOPWORDS.has(w)) return;
    counts.set(w, (counts.get(w) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function openSimilarSearch(work) {
  const keywords = extractKeywords(work.abstract || work.title || "");
  if (keywords.length === 0) return;
  const searchParams = new URLSearchParams({ q: keywords.join(" "), sourceTitle: work.title });
  chrome.tabs.create({ url: chrome.runtime.getURL("search.html") + "?" + searchParams.toString() });
}

const params = new URLSearchParams(window.location.search);
const issn = params.get("issn") || "";
const volume = params.get("volume") || "";
const issue = params.get("issue") || "";
const journal = params.get("journal") || "";
const year = params.get("year") || "";

const issueLabel = journal
  ? `${journal} — Vol. ${volume}, Issue ${issue}`
  : `Vol. ${volume}, Issue ${issue}`;
issueTitleEl.textContent = issueLabel;

let isWatching = false;

function updateWatchButton() {
  btnWatch.textContent = isWatching ? "★ Watching This Journal" : "Watch This Journal";
}

async function initWatchButton() {
  if (!issn) return;
  const watchlist = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "getWatchlist" }, resolve));
  isWatching = Array.isArray(watchlist) && watchlist.some((w) => w.issn === issn);
  updateWatchButton();
  btnWatch.disabled = false;
}

btnWatch.addEventListener("click", () => {
  if (!issn) return;
  btnWatch.disabled = true;
  chrome.runtime.sendMessage({ action: "toggleWatch", issn, journal, volume, issue, year }, (resp) => {
    btnWatch.disabled = false;
    if (!resp || !resp.success) return;
    isWatching = resp.watching;
    updateWatchButton();
  });
});

function sanitizeFolderName(name) {
  return name.replace(/[^\w\-. ]/g, "").trim().replace(/\s+/g, " ") || "issue";
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["outputDir"], resolve);
  });
}

// Pages can't know the user's home directory themselves — asks the native
// host, which resolves it via os.path.expanduser("~"), for the "leave output
// folder blank" default instead of hardcoding one machine's path.
function getDefaultOutputDir() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDefaultOutputDir" }, (resp) => {
      resolve(resp && resp.success && resp.path ? resp.path : "");
    });
  });
}

let works = []; // master list, Crossref order — never reordered
let displayWorks = []; // current sorted view, rendered from
const selectedKeys = new Set(); // work.doi (or title as fallback) for works checked to download
const alreadyDownloaded = new Set(); // doi -> previously SUCCEEDED per this issue's own log
const failedKeys = new Set(); // doi -> failed/corrupt in the most recent run, for "Retry Failed"

let outputDirOverride = null;
let logPath = null;
let baseOutputDir = null; // parent folder, one level up from this issue's own subfolder

function workKey(work) {
  return work.doi || work.title;
}

// Resolve this issue's dedicated output folder + log path once, up front,
// so both the initial "skip already-downloaded" pass and every download
// button write to the same place.
async function resolveOutputPaths() {
  const settings = await getSettings();
  baseOutputDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseOutputDir) baseOutputDir = (await getDefaultOutputDir()).replace(/\/+$/, "");
  const folderName = sanitizeFolderName(`${journal || issn} Vol ${volume} Issue ${issue}`);
  outputDirOverride = `${baseOutputDir}/${folderName}`;
  logPath = `${outputDirOverride}/download_log.txt`;
}

// Parses this issue's own download_log.txt (written by this page) to find
// DOIs that already succeeded, so re-opening the page or re-running a batch
// skips them instead of re-downloading. Format: "timestamp | STATUS | doi | title | detail".
function parseLog(content) {
  const statusByDOI = new Map();
  content.split("\n").forEach((line) => {
    const parts = line.split(" | ");
    if (parts.length < 3) return;
    const status = parts[1];
    const doi = parts[2];
    if (status === "SUMMARY") return;
    statusByDOI.set(doi, status); // last occurrence wins
  });
  return statusByDOI;
}

function logLine(line) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  chrome.runtime.sendMessage({ action: "appendLog", filepath: logPath, line: `${timestamp} | ${line}` });
}

function sortWorks(order) {
  const copy = works.slice();
  if (order === "downloadable") {
    // Stable sort — keeps table-of-contents order within each group, just
    // floats the no-DOI rows to the bottom instead of leaving them scattered.
    copy.sort((a, b) => (b.doi ? 1 : 0) - (a.doi ? 1 : 0));
  } else if (order === "citations") {
    copy.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  }
  return copy;
}

function renderWorks() {
  if (displayWorks.length === 0) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";
  listEl.innerHTML = "";
  listEl.style.display = "block";

  displayWorks.forEach((work, i) => {
    const row = document.createElement("div");
    row.className = "work-row" + (work.doi ? "" : " no-doi");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedKeys.has(workKey(work));
    checkbox.disabled = !work.doi;
    checkbox.dataset.index = i;

    const info = document.createElement("div");
    info.className = "work-info";

    const title = document.createElement("div");
    title.className = "work-title" + (work.abstract ? " has-abstract" : "");
    title.textContent = work.title;
    if (work.abstract) {
      title.addEventListener("mouseenter", (e) => showAbstractTooltip(work.abstract, e.clientX, e.clientY));
      title.addEventListener("mousemove", (e) => showAbstractTooltip(work.abstract, e.clientX, e.clientY));
      title.addEventListener("mouseleave", hideAbstractTooltip);
    }

    const meta = document.createElement("div");
    meta.className = "work-meta";
    const citationText = work.citations != null ? `${work.citations} citation${work.citations === 1 ? "" : "s"}` : "";
    const metaParts = [work.author, work.page ? `p. ${work.page}` : "", citationText, work.doi || "no DOI found"].filter(Boolean);
    meta.textContent = metaParts.join(" · ");
    meta.appendChild(document.createTextNode(" · "));
    const similarLink = document.createElement("span");
    similarLink.className = "find-similar";
    similarLink.textContent = "Find Similar";
    similarLink.addEventListener("click", () => openSimilarSearch(work));
    meta.appendChild(similarLink);

    info.appendChild(title);
    info.appendChild(meta);

    const status = document.createElement("div");
    status.className = "work-status";
    status.id = "status-" + i;
    if (work.doi && alreadyDownloaded.has(work.doi)) {
      status.textContent = "Already downloaded ✓";
      status.className = "work-status ok";
    }

    row.appendChild(checkbox);
    row.appendChild(info);
    row.appendChild(status);
    listEl.appendChild(row);
  });

  applyFilter();
  updateDownloadButton();
}

// Purely visual — hides rows whose title doesn't match the search box, but
// leaves displayWorks/selection/status ids untouched so downloads and
// retry-failed all keep working off the full (unfiltered) index space.
function applyFilter() {
  const query = searchInput.value.trim().toLowerCase();
  const rows = listEl.querySelectorAll(".work-row");
  let visibleCount = 0;

  rows.forEach((row, i) => {
    const work = displayWorks[i];
    const title = work ? work.title.toLowerCase() : "";
    const matches = !query || title.includes(query);
    row.style.display = matches ? "flex" : "none";
    if (matches) visibleCount += 1;
  });

  noMatchesEl.style.display = query && visibleCount === 0 ? "block" : "none";
}

searchInput.addEventListener("input", applyFilter);

// Cmd+F (Mac) / Ctrl+F (Windows/Linux) focuses our own filter box instead of
// the browser's native find bar.
document.addEventListener("keydown", (e) => {
  const modifier = navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
  if (modifier && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

function getSelectedIndices() {
  return Array.from(listEl.querySelectorAll("input[type=checkbox]:checked")).map((cb) => Number(cb.dataset.index));
}

function updateDownloadButton() {
  const selected = getSelectedIndices();
  btnDownload.disabled = selected.length === 0;
  btnDownload.textContent = selected.length > 0 ? `Download Selected (${selected.length})` : "Download Selected";
}

listEl.addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  const work = displayWorks[Number(e.target.dataset.index)];
  if (e.target.checked) {
    selectedKeys.add(workKey(work));
  } else {
    selectedKeys.delete(workKey(work));
  }
  updateDownloadButton();
});

btnSelectAll.addEventListener("click", () => {
  displayWorks.forEach((work) => {
    if (work.doi) selectedKeys.add(workKey(work));
  });
  renderWorks();
});

btnSelectNone.addEventListener("click", () => {
  displayWorks.forEach((work) => selectedKeys.delete(workKey(work)));
  renderWorks();
});

document.getElementById("sort-select").addEventListener("change", (e) => {
  displayWorks = sortWorks(e.target.value);
  renderWorks();
});

async function runDownload(indices) {
  if (indices.length === 0) return;

  btnDownload.disabled = true;
  btnRetryFailed.disabled = true;
  btnSelectAll.disabled = true;
  btnSelectNone.disabled = true;

  progressBarWrap.style.display = "block";
  progressBar.style.width = "0%";

  let done = 0;
  let failed = 0;
  const batchStart = Date.now();

  function formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  for (const i of indices) {
    const work = displayWorks[i];
    failedKeys.delete(workKey(work));

    const completed = done + failed;
    const statusEl = document.getElementById("status-" + i);
    statusEl.textContent = "Downloading…";
    statusEl.className = "work-status pending";
    progressBar.style.width = Math.round((completed / indices.length) * 100) + "%";

    let etaText = "";
    if (completed > 0) {
      const avgMs = (Date.now() - batchStart) / completed;
      const remaining = indices.length - completed;
      etaText = ` — est. ${formatDuration(avgMs * remaining)} remaining`;
    }
    statusLineEl.textContent = `Downloading ${completed + 1} of ${indices.length}…${etaText}`;

    // Sequential, not parallel — racing many DOIs against Sci-Hub mirrors at
    // once makes them flaky.
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride }, (resp) => {
        const result = resp && resp.result;
        if (resp && resp.success && result && result.status === "ok") {
          const isOa = result.source === "open_access";
          statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
          statusEl.className = "work-status ok";
          done += 1;
          alreadyDownloaded.add(work.doi);
          logLine(`SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}${isOa ? " | open_access" : ""}`);
        } else if (resp && resp.success && result && result.status === "corrupt") {
          statusEl.textContent = "Corrupt file";
          statusEl.className = "work-status err";
          failed += 1;
          failedKeys.add(workKey(work));
          logLine(`CORRUPT | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
        } else {
          statusEl.textContent = "Not found";
          statusEl.className = "work-status err";
          failed += 1;
          failedKeys.add(workKey(work));
          const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
          logLine(`FAILED | ${work.doi} | ${work.title} | ${detail}`);
        }
        resolve();
      });
    });
  }

  logLine(`SUMMARY | ${done} downloaded, ${failed} failed, ${indices.length} total`);
  statusLineEl.textContent = `Done — ${done} downloaded, ${failed} failed. Saved to ${outputDirOverride}`;
  progressBar.style.width = "100%";
  setTimeout(() => { progressBarWrap.style.display = "none"; }, 600);
  btnSelectAll.disabled = false;
  btnSelectNone.disabled = false;
  btnRetryFailed.style.display = failedKeys.size > 0 ? "block" : "none";
  btnRetryFailed.disabled = false;
  btnRetryFailed.textContent = `Retry Failed (${failedKeys.size})`;
  btnOpenFolder.style.display = done > 0 ? "block" : btnOpenFolder.style.display;
  updateDownloadButton();
}

btnDownload.addEventListener("click", () => {
  runDownload(getSelectedIndices());
});

btnRetryFailed.addEventListener("click", () => {
  const indices = [];
  displayWorks.forEach((work, i) => {
    if (failedKeys.has(workKey(work))) indices.push(i);
  });
  runDownload(indices);
});

btnOpenFolder.addEventListener("click", () => {
  btnOpenFolder.disabled = true;
  chrome.runtime.sendMessage({ action: "openFolder", folder: outputDirOverride }, (resp) => {
    btnOpenFolder.disabled = false;
    if (!resp || !resp.success) {
      statusLineEl.textContent = "Couldn't open folder: " + (resp?.error || "Unknown error");
    }
  });
});

async function init() {
  if (!issn || !volume || !issue) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Missing issue info (ISSN/volume/issue).";
    subtitleEl.textContent = "";
    return;
  }

  await resolveOutputPaths();
  initWatchButton();

  const [searchResp, logResp] = await Promise.all([
    new Promise((resolve) => chrome.runtime.sendMessage({ action: "getIssueWorks", issn, volume, issue, year }, resolve)),
    new Promise((resolve) => chrome.runtime.sendMessage({ action: "readLog", filepath: logPath }, resolve)),
  ]);

  loadingEl.style.display = "none";

  if (!searchResp || !searchResp.success) {
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't search Crossref: " + (searchResp?.error || "Unknown error");
    subtitleEl.textContent = "";
    return;
  }

  if (logResp && logResp.success && logResp.content) {
    const statusByDOI = parseLog(logResp.content);
    statusByDOI.forEach((status, doi) => {
      if (status === "SUCCESS") alreadyDownloaded.add(doi);
    });
  }

  works = searchResp.works || [];
  works.forEach((w) => {
    // Default-select everything downloadable except what's already done —
    // this is the "skip what's already downloaded" behavior.
    if (w.doi && !alreadyDownloaded.has(w.doi)) selectedKeys.add(workKey(w));
  });
  displayWorks = works.slice();

  const withDOI = works.filter((w) => w.doi).length;
  const skipped = alreadyDownloaded.size;
  subtitleEl.textContent = `${works.length} works found on Crossref (${withDOI} downloadable)` +
    (skipped > 0 ? ` — ${skipped} already downloaded` : "");
  if (skipped > 0) btnOpenFolder.style.display = "block";
  renderWorks();
}

document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  window.toggleTheme();
});

// --- Batch download infrastructure (shared by volume-range + whole-journal) ---
// Each mode produces a sequence of "issue groups" (volume + issue number +
// works[]) and hands them to the same downloadIssueGroup()/pause/cancel
// machinery, so pausing or cancelling works identically for both.
const batchVolFromEl = document.getElementById("batch-vol-from");
const batchVolToEl = document.getElementById("batch-vol-to");
const batchIssueNumEl = document.getElementById("batch-issue-num");
const btnQueueBatch = document.getElementById("btn-queue-batch");
const btnDownloadJournal = document.getElementById("btn-download-journal");
const batchStatusListEl = document.getElementById("batch-status-list");
const batchRunControlsEl = document.getElementById("batch-run-controls");
const btnBatchPause = document.getElementById("btn-batch-pause");
const btnBatchCancel = document.getElementById("btn-batch-cancel");

batchIssueNumEl.value = issue;

function addBatchStatusRow(text) {
  const row = document.createElement("div");
  row.className = "batch-status-row";
  row.textContent = text;
  batchStatusListEl.appendChild(row);
  batchStatusListEl.scrollTop = batchStatusListEl.scrollHeight;
  return row;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only one batch (of either kind) can run at a time — shared state so the
// Pause/Cancel row controls whichever one is active.
let batchControl = null;

function startBatchControls() {
  batchControl = { paused: false, cancelled: false };
  batchRunControlsEl.style.display = "flex";
  btnBatchPause.textContent = "Pause";
  btnBatchPause.disabled = false;
  btnBatchCancel.disabled = false;
  btnQueueBatch.disabled = true;
  btnDownloadJournal.disabled = true;
  return batchControl;
}

function endBatchControls() {
  batchRunControlsEl.style.display = "none";
  btnQueueBatch.disabled = false;
  btnDownloadJournal.disabled = false;
  batchControl = null;
}

async function waitWhilePaused(control) {
  while (control.paused && !control.cancelled) {
    await sleep(300);
  }
}

btnBatchPause.addEventListener("click", () => {
  if (!batchControl) return;
  batchControl.paused = !batchControl.paused;
  btnBatchPause.textContent = batchControl.paused ? "Resume" : "Pause";
});

btnBatchCancel.addEventListener("click", () => {
  if (!batchControl) return;
  batchControl.cancelled = true;
  batchControl.paused = false; // don't leave it stuck inside waitWhilePaused
  btnBatchPause.disabled = true;
  btnBatchCancel.disabled = true;
});

// Downloads one issue's worth of works into its own subfolder + log,
// checking pause/cancel between every single DOI (not just between issues)
// so a click takes effect within seconds, not after a whole issue finishes.
async function downloadIssueGroup(control, row, label, folderKey, works) {
  const folderName = sanitizeFolderName(folderKey);
  const outputDir = `${baseOutputDir}/${folderName}`;
  const logPath = `${outputDir}/download_log.txt`;

  let done = 0;
  let failed = 0;
  const failedWorks = [];

  for (const work of works) {
    await waitWhilePaused(control);
    if (control.cancelled) return { done, failed, failedWorks, cancelled: true };

    row.textContent = `${label}: downloading ${done + failed + 1}/${works.length}…`;

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride: outputDir }, (resp) => {
        const result = resp && resp.result;
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (resp && resp.success && result && result.status === "ok") {
          done += 1;
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}`,
          });
        } else {
          failed += 1;
          failedWorks.push(work);
          const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
          const status = result && result.status === "corrupt" ? "CORRUPT" : "FAILED";
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | ${status} | ${work.doi} | ${work.title} | ${detail}`,
          });
        }
        resolve();
      });
    });
  }

  return { done, failed, failedWorks, cancelled: false };
}

// --- Batch Download Multiple Issues (volume range) --------------------------
async function runVolumeRangeBatch(fromVol, toVol, issueNum) {
  const control = startBatchControls();
  batchStatusListEl.innerHTML = "";

  for (let vol = fromVol; vol <= toVol; vol++) {
    await waitWhilePaused(control);
    if (control.cancelled) {
      addBatchStatusRow("Cancelled.").className = "batch-status-row err";
      break;
    }

    const label = `Vol. ${vol}, Issue ${issueNum}`;
    const row = addBatchStatusRow(`${label}: looking up on Crossref…`);

    const searchResp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ action: "getIssueWorks", issn, volume: String(vol), issue: issueNum }, resolve)
    );

    if (!searchResp || !searchResp.success) {
      row.textContent = `${label}: lookup failed — ${searchResp?.error || "unknown error"}`;
      row.className = "batch-status-row err";
      continue;
    }

    const volWorks = (searchResp.works || []).filter((w) => w.doi);
    if (volWorks.length === 0) {
      row.textContent = `${label}: no downloadable works found`;
      continue;
    }

    const result = await downloadIssueGroup(control, row, label, `${journal || issn} Vol ${vol} Issue ${issueNum}`, volWorks);
    if (result.cancelled) {
      row.textContent = `${label}: cancelled after ${result.done} downloaded, ${result.failed} failed`;
      row.className = "batch-status-row err";
      break;
    }
    row.textContent = `${label}: done — ${result.done} downloaded, ${result.failed} failed`;
    row.className = "batch-status-row " + (result.failed > 0 ? "err" : "ok");
  }

  endBatchControls();
}

btnQueueBatch.addEventListener("click", () => {
  const fromVol = parseInt(batchVolFromEl.value, 10);
  const toVol = parseInt(batchVolToEl.value, 10);
  const issueNum = batchIssueNumEl.value.trim();

  batchStatusListEl.innerHTML = "";
  if (!fromVol || !toVol || fromVol > toVol) {
    addBatchStatusRow("Enter a valid volume range (From ≤ To).").className = "batch-status-row err";
    return;
  }
  if (!issueNum) {
    addBatchStatusRow("Enter an issue number.").className = "batch-status-row err";
    return;
  }
  if (toVol - fromVol > 50) {
    addBatchStatusRow("Range too large (max 50 volumes at once).").className = "batch-status-row err";
    return;
  }
  if (!baseOutputDir) {
    addBatchStatusRow("Still loading this page's settings — try again in a moment.").className = "batch-status-row err";
    return;
  }

  runVolumeRangeBatch(fromVol, toVol, issueNum);
});

// --- Search This Journal ------------------------------------------------------
// Crossref-side keyword search scoped to this ISSN (searchJournalKeyword,
// background.js) — much cheaper than getAllJournalWorks since Crossref does
// the filtering, not us. Results reuse the same .work-row/.work-title/
// .work-meta classes as the main issue list below for a consistent look.
const journalSearchInput = document.getElementById("journal-search-input");
const btnJournalSearch = document.getElementById("btn-journal-search");
const btnDownloadAllMatches = document.getElementById("btn-download-all-matches");
const btnRetrySearchFailed = document.getElementById("btn-retry-search-failed");
const journalSearchStatusEl = document.getElementById("journal-search-status");
const journalSearchResultsEl = document.getElementById("journal-search-results");
const journalSearchSortEl = document.getElementById("journal-search-sort");
const btnLoadMoreMatches = document.getElementById("btn-load-more-matches");
const btnJumpToTop = document.getElementById("btn-jump-to-top");
const journalSearchCardEl = document.getElementById("journal-search-card");
const btnExpandAbstracts = document.getElementById("btn-expand-abstracts");

let lastSearchMatches = []; // master list, Crossref relevance order — never reordered
let lastSearchQuery = "";
let lastFailedSearchWorks = [];
let lastSearchTotalResults = 0; // Crossref's total match count, not just what's been fetched so far
let abstractsExpanded = false;

btnExpandAbstracts.addEventListener("click", () => {
  abstractsExpanded = !abstractsExpanded;
  btnExpandAbstracts.textContent = abstractsExpanded ? "Collapse Abstracts" : "Expand All Abstracts";
  renderJournalSearchResults(sortSearchMatches(lastSearchMatches, journalSearchSortEl.value), lastSearchQuery);
});

function sortSearchMatches(matches, order) {
  const copy = matches.slice();
  if (order === "citations") {
    copy.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  } else if (order === "newest") {
    copy.sort((a, b) => (b.year || 0) - (a.year || 0));
  } else if (order === "oldest") {
    copy.sort((a, b) => (a.year || 9999) - (b.year || 9999));
  }
  return copy;
}

journalSearchSortEl.addEventListener("change", (e) => {
  renderJournalSearchResults(sortSearchMatches(lastSearchMatches, e.target.value), lastSearchQuery);
});

function downloadSingleSearchResult(work, btn, statusEl) {
  btn.disabled = true;
  statusEl.textContent = "Downloading…";
  statusEl.className = "work-status pending";

  const folderName = sanitizeFolderName(`${journal || issn} Keyword Search`);
  const outputDir = `${baseOutputDir}/${folderName}`;
  const logPath = `${outputDir}/download_log.txt`;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride: outputDir }, (resp) => {
    btn.disabled = false;
    const result = resp && resp.result;
    if (resp && resp.success && result && result.status === "ok") {
      const isOa = result.source === "open_access";
      statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
      statusEl.className = "work-status ok";
      chrome.runtime.sendMessage({
        action: "appendLog",
        filepath: logPath,
        line: `${timestamp} | SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}${isOa ? " | open_access" : ""}`,
      });
    } else {
      statusEl.textContent = "Failed";
      statusEl.className = "work-status err";
      const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
      chrome.runtime.sendMessage({
        action: "appendLog",
        filepath: logPath,
        line: `${timestamp} | FAILED | ${work.doi} | ${work.title} | ${detail}`,
      });
    }
  });
}

function renderJournalSearchResults(matches, query) {
  journalSearchResultsEl.innerHTML = "";

  if (matches.length === 0) {
    btnDownloadAllMatches.style.display = "none";
    journalSearchSortEl.style.display = "none";
    btnExpandAbstracts.style.display = "none";
    return;
  }

  journalSearchSortEl.style.display = "inline-block";
  btnExpandAbstracts.style.display = matches.some((w) => w.abstract) ? "inline-block" : "none";

  const terms = query.split(/\s+/).filter(Boolean);

  matches.forEach((work) => {
    const row = document.createElement("div");
    row.className = "work-row" + (work.doi ? "" : " no-doi");

    const info = document.createElement("div");
    info.className = "work-info";

    const title = document.createElement("div");
    title.className = "work-title" + (work.abstract && !abstractsExpanded ? " has-abstract" : "");
    title.innerHTML = highlightTerms(work.title, terms);
    if (work.abstract && !abstractsExpanded) {
      title.addEventListener("mouseenter", (e) => showAbstractTooltip(work.abstract, e.clientX, e.clientY, query));
      title.addEventListener("mousemove", (e) => showAbstractTooltip(work.abstract, e.clientX, e.clientY, query));
      title.addEventListener("mouseleave", hideAbstractTooltip);
    }

    const meta = document.createElement("div");
    meta.className = "work-meta";
    const volumeText = work.volume ? `Vol. ${work.volume}${work.issue ? ", Issue " + work.issue : ""}` : "";
    const citationText = work.citations != null ? `${work.citations} citation${work.citations === 1 ? "" : "s"}` : "";
    meta.textContent = [work.author, volumeText, citationText, work.doi || "no DOI found"].filter(Boolean).join(" · ");

    info.appendChild(title);
    info.appendChild(meta);

    if (abstractsExpanded && work.abstract) {
      const abstractEl = document.createElement("div");
      abstractEl.className = "work-abstract-inline";
      abstractEl.innerHTML = highlightTerms(work.abstract, terms);
      info.appendChild(abstractEl);
    }

    const status = document.createElement("div");
    status.className = "work-status";

    const dlBtn = document.createElement("button");
    dlBtn.textContent = "Download";
    dlBtn.disabled = !work.doi;
    dlBtn.addEventListener("click", () => downloadSingleSearchResult(work, dlBtn, status));

    row.appendChild(info);
    row.appendChild(dlBtn);
    row.appendChild(status);
    journalSearchResultsEl.appendChild(row);
  });

  btnDownloadAllMatches.style.display = matches.some((w) => w.doi) ? "block" : "none";
}

function updateSearchStatusText() {
  const shown = lastSearchMatches.length;
  const suffix = lastSearchTotalResults > shown ? ` of ${lastSearchTotalResults} total` : "";
  journalSearchStatusEl.textContent = `${shown} match${shown === 1 ? "" : "es"} found${suffix}`;
}

function updateLoadMoreButton() {
  btnLoadMoreMatches.style.display = lastSearchMatches.length < lastSearchTotalResults ? "block" : "none";
}

// Only worth showing once the list is long enough to actually need it —
// mainly appears after at least one "Load More" click.
function updateJumpToTopButton() {
  btnJumpToTop.style.display = lastSearchMatches.length > 20 ? "block" : "none";
}

btnJumpToTop.addEventListener("click", () => {
  journalSearchCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

function runJournalSearch() {
  const query = journalSearchInput.value.trim();
  if (!query) {
    journalSearchStatusEl.textContent = "Enter a keyword to search for.";
    return;
  }

  btnJournalSearch.disabled = true;
  journalSearchStatusEl.textContent = "Searching…";
  journalSearchResultsEl.innerHTML = "";
  btnDownloadAllMatches.style.display = "none";
  btnLoadMoreMatches.style.display = "none";
  btnJumpToTop.style.display = "none";
  journalSearchSortEl.style.display = "none";
  journalSearchSortEl.value = "relevance";

  chrome.runtime.sendMessage({ action: "searchJournalKeyword", issn, query, offset: 0 }, (resp) => {
    btnJournalSearch.disabled = false;

    if (!resp || !resp.success) {
      journalSearchStatusEl.textContent = `Search failed: ${resp?.error || "unknown error"}`;
      return;
    }

    lastSearchMatches = resp.works || [];
    lastSearchQuery = query;
    lastSearchTotalResults = resp.totalResults || lastSearchMatches.length;
    lastFailedSearchWorks = [];
    btnRetrySearchFailed.style.display = "none";
    updateSearchStatusText();
    updateLoadMoreButton();
    updateJumpToTopButton();
    renderJournalSearchResults(sortSearchMatches(lastSearchMatches, journalSearchSortEl.value), query);
  });
}

function loadMoreMatches() {
  btnLoadMoreMatches.disabled = true;
  btnLoadMoreMatches.textContent = "Loading…";

  chrome.runtime.sendMessage(
    { action: "searchJournalKeyword", issn, query: lastSearchQuery, offset: lastSearchMatches.length },
    (resp) => {
      btnLoadMoreMatches.disabled = false;
      btnLoadMoreMatches.textContent = "Load More";

      if (!resp || !resp.success) {
        journalSearchStatusEl.textContent = `Couldn't load more: ${resp?.error || "unknown error"}`;
        return;
      }

      lastSearchMatches = lastSearchMatches.concat(resp.works || []);
      lastSearchTotalResults = resp.totalResults || lastSearchTotalResults;
      updateSearchStatusText();
      updateLoadMoreButton();
      updateJumpToTopButton();
      renderJournalSearchResults(sortSearchMatches(lastSearchMatches, journalSearchSortEl.value), lastSearchQuery);
    }
  );
}

btnJournalSearch.addEventListener("click", runJournalSearch);
journalSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runJournalSearch();
});
btnLoadMoreMatches.addEventListener("click", loadMoreMatches);

async function runKeywordSearchBatch(works, query) {
  const control = startBatchControls();
  batchStatusListEl.innerHTML = "";
  btnRetrySearchFailed.style.display = "none";

  const label = `Keyword "${query}"`;
  const row = addBatchStatusRow(`${label}: downloading 0/${works.length}…`);

  const result = await downloadIssueGroup(control, row, label, `${journal || issn} Keyword ${query}`, works);
  lastFailedSearchWorks = result.failedWorks || [];

  if (result.cancelled) {
    row.textContent = `${label}: cancelled after ${result.done} downloaded, ${result.failed} failed`;
    row.className = "batch-status-row err";
  } else {
    row.textContent = `${label}: done — ${result.done} downloaded, ${result.failed} failed`;
    row.className = "batch-status-row " + (result.failed > 0 ? "err" : "ok");
  }

  if (lastFailedSearchWorks.length > 0) {
    btnRetrySearchFailed.textContent = `Retry Failed (${lastFailedSearchWorks.length})`;
    btnRetrySearchFailed.style.display = "block";
  }

  endBatchControls();
}

btnDownloadAllMatches.addEventListener("click", () => {
  if (!baseOutputDir) {
    journalSearchStatusEl.textContent = "Still loading this page's settings — try again in a moment.";
    return;
  }
  const downloadable = lastSearchMatches.filter((w) => w.doi);
  if (downloadable.length === 0) return;
  runKeywordSearchBatch(downloadable, lastSearchQuery);
});

btnRetrySearchFailed.addEventListener("click", () => {
  if (lastFailedSearchWorks.length === 0) return;
  runKeywordSearchBatch(lastFailedSearchWorks, lastSearchQuery);
});

// --- Download Entire Journal -------------------------------------------------
// Walking every issue Crossref has for a journal can mean hundreds of issues
// and thousands of works — too much to track as a single status line in the
// shared #batch-status-list, so this opens a dedicated tab (journal-download
// .html/.js) with a foldable per-issue list, per-article progress, and its
// own Pause/Cancel controls, instead of running inline on this page.
btnDownloadJournal.addEventListener("click", () => {
  const confirmed = confirm(
    "This will attempt to download every work Crossref has for this journal. It can take a very long time and download a lot of files. Continue?"
  );
  if (!confirmed) return;

  const searchParams = new URLSearchParams({ issn, journal: journal || "" });
  chrome.tabs.create({ url: chrome.runtime.getURL("journal-download.html") + "?" + searchParams.toString() });
});

init();
