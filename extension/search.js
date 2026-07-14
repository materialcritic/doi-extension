const searchTitleEl = document.getElementById("search-title");
const subtitleEl = document.getElementById("subtitle");
const keywordLineEl = document.getElementById("keyword-line");
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

// Positions near the cursor but nudged to stay on-screen, since the tooltip's
// width isn't known until its text is set.
function showAbstractTooltip(text, x, y) {
  abstractTooltipEl.textContent = text;
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
// than doing any real NLP. Kept here too so a similarity search can itself
// be chained into a further one.
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
const query = params.get("q") || "";
const sourceTitle = params.get("sourceTitle") || "";

searchTitleEl.textContent = sourceTitle ? `Similar to: ${sourceTitle}` : "Similar Papers";
keywordLineEl.textContent = query ? `Searched Crossref for: ${query}` : "";

function sanitizeFolderName(name) {
  return name.replace(/[^\w\-. ]/g, "").trim().replace(/\s+/g, " ") || "similar-papers";
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

let works = []; // master list, Crossref relevance order — never reordered
let displayWorks = []; // current sorted view, rendered from
const selectedKeys = new Set(); // work.doi (or title as fallback) for works checked to download
const alreadyDownloaded = new Set(); // doi -> previously SUCCEEDED per this search's own log
const failedKeys = new Set(); // doi -> failed/corrupt in the most recent run, for "Retry Failed"

let outputDirOverride = null;
let logPath = null;

function workKey(work) {
  return work.doi || work.title;
}

// Resolve this search's dedicated output folder + log path once, up front,
// so both the initial "skip already-downloaded" pass and every download
// button write to the same place.
async function resolveOutputPaths() {
  const settings = await getSettings();
  let baseDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseDir) baseDir = (await getDefaultOutputDir()).replace(/\/+$/, "");
  const folderName = sanitizeFolderName(`Similar Papers - ${sourceTitle || query}`);
  outputDirOverride = `${baseDir}/${folderName}`;
  logPath = `${outputDirOverride}/download_log.txt`;
}

// Parses this search's own download_log.txt (written by this page) to find
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
    // Stable sort — keeps relevance order within each group, just floats
    // the no-DOI rows to the bottom instead of leaving them scattered.
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
    const metaParts = [work.journal, work.author, work.year, citationText, work.doi || "no DOI found"].filter(Boolean);
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
  const filterQuery = searchInput.value.trim().toLowerCase();
  const rows = listEl.querySelectorAll(".work-row");
  let visibleCount = 0;

  rows.forEach((row, i) => {
    const work = displayWorks[i];
    const title = work ? work.title.toLowerCase() : "";
    const matches = !filterQuery || title.includes(filterQuery);
    row.style.display = matches ? "flex" : "none";
    if (matches) visibleCount += 1;
  });

  noMatchesEl.style.display = filterQuery && visibleCount === 0 ? "block" : "none";
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
          statusEl.textContent = "Downloaded ✓";
          statusEl.className = "work-status ok";
          done += 1;
          alreadyDownloaded.add(work.doi);
          logLine(`SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
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
  if (!query) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "No search keywords provided.";
    subtitleEl.textContent = "";
    return;
  }

  await resolveOutputPaths();

  const [searchResp, logResp] = await Promise.all([
    new Promise((resolve) => chrome.runtime.sendMessage({ action: "searchBibliographic", query }, resolve)),
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

init();
