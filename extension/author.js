const authorNameEl = document.getElementById("author-name");
const authorAvatarEl = document.getElementById("author-avatar");
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
const batchRunControlsEl = document.getElementById("batch-run-controls");
const btnBatchPause = document.getElementById("btn-batch-pause");
const btnBatchCancel = document.getElementById("btn-batch-cancel");
const yearHistogramEl = document.getElementById("year-histogram");
const externalLinksEl = document.querySelector(".external-links");
const btnScholar = document.getElementById("btn-scholar");
const btnInstitution = document.getElementById("btn-institution");
const btnCollaboratorsPage = document.getElementById("btn-collaborators-page");
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
// than doing any real NLP.
function openSimilarSearch(work) {
  const keywords = extractKeywords(work.abstract || work.title || "");
  if (keywords.length === 0) return;
  const searchParams = new URLSearchParams({ q: keywords.join(" "), sourceTitle: work.title });
  chrome.tabs.create({ url: chrome.runtime.getURL("search.html") + "?" + searchParams.toString() });
}

const params = new URLSearchParams(window.location.search);
const authorName = params.get("author") || "";

authorNameEl.textContent = authorName || "Unknown author";

const btnWatchAuthor = document.getElementById("btn-watch-author");
let isWatchingAuthor = false;

function updateWatchAuthorButton() {
  btnWatchAuthor.textContent = isWatchingAuthor ? "★ Watching This Author" : "Watch This Author";
}

async function initWatchAuthorButton() {
  if (!authorName) return;
  const watchlist = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "getAuthorWatchlist" }, resolve));
  isWatchingAuthor = Array.isArray(watchlist) && watchlist.some((w) => w.author === authorName);
  updateWatchAuthorButton();
  btnWatchAuthor.disabled = false;
}

btnWatchAuthor.addEventListener("click", () => {
  if (!authorName) return;
  btnWatchAuthor.disabled = true;
  chrome.runtime.sendMessage({ action: "toggleAuthorWatch", author: authorName }, (resp) => {
    btnWatchAuthor.disabled = false;
    if (!resp || !resp.success) return;
    isWatchingAuthor = resp.watching;
    updateWatchAuthorButton();
  });
});

function sanitizeFolderName(name) {
  return name.replace(/[^\w\-. ]/g, "").trim().replace(/\s+/g, " ") || "author";
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
const alreadyDownloaded = new Set(); // doi -> previously SUCCEEDED per the author's own log
const failedKeys = new Set(); // doi -> failed/corrupt in the most recent run, for "Retry Failed"

let outputDirOverride = null;
let logPath = null;

function workKey(work) {
  return work.doi || work.title;
}

// Resolve the author's dedicated output folder + log path once, up front,
// so both the initial "skip already-downloaded" pass and every download
// button write to the same place.
async function resolveOutputPaths() {
  const settings = await getSettings();
  let baseDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseDir) baseDir = (await getDefaultOutputDir()).replace(/\/+$/, "");
  const folderName = sanitizeFolderName(authorName);
  outputDirOverride = `${baseDir}/${folderName}`;
  logPath = `${outputDirOverride}/download_log.txt`;
}

// Parses this author's own download_log.txt (written by this page) to find
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

const SVG_NS = "http://www.w3.org/2000/svg";
let yearFilter = null; // set to a year number to restrict the list to it, or null

// Suspiciously wide year ranges usually mean Crossref's fuzzy author-text
// search pulled in a different person who happens to share the name.
const SUSPICIOUS_RANGE_YEARS = 90;

function renderYearHistogram() {
  const years = works.map((w) => w.year).filter(Boolean);
  if (years.length === 0) {
    document.getElementById("year-histogram-wrap").style.display = "none";
    return;
  }

  const counts = new Map();
  years.forEach((y) => counts.set(y, (counts.get(y) || 0) + 1));

  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const maxCount = Math.max(...counts.values());
  const numYears = maxYear - minYear + 1;

  const rangeWarningEl = document.getElementById("range-warning");
  if (maxYear - minYear > SUSPICIOUS_RANGE_YEARS) {
    rangeWarningEl.style.display = "block";
    rangeWarningEl.textContent =
      `Works span ${minYear}–${maxYear} (${maxYear - minYear} years) — this may be catching more than one person with this name.`;
  } else {
    rangeWarningEl.style.display = "none";
  }

  let peakYear = minYear;
  counts.forEach((c, y) => { if (c > (counts.get(peakYear) || 0)) peakYear = y; });
  document.getElementById("peak-year-label").textContent =
    `Peak: ${peakYear} (${counts.get(peakYear)} work${counts.get(peakYear) === 1 ? "" : "s"})`;

  document.getElementById("year-histogram-wrap").style.display = "block";
  yearHistogramEl.setAttribute("viewBox", `0 0 ${numYears} 100`);
  yearHistogramEl.innerHTML = "";

  const yAxisSpans = document.querySelectorAll("#year-histogram-yaxis span");
  yAxisSpans[0].textContent = maxCount;
  yAxisSpans[1].textContent = maxCount > 1 ? Math.round(maxCount / 2) : "";

  const xAxisEl = document.getElementById("year-histogram-xaxis");
  xAxisEl.innerHTML = "";
  const maxTicks = 6;
  const tickStep = Math.max(1, Math.ceil(numYears / maxTicks));
  const xTickYears = new Set();
  for (let y = minYear; y <= maxYear; y += tickStep) xTickYears.add(y);
  xTickYears.add(maxYear);
  xTickYears.forEach((y) => {
    const label = document.createElement("span");
    label.textContent = y;
    label.style.left = `${((y - minYear + 0.5) / numYears) * 100}%`;
    xAxisEl.appendChild(label);
  });

  const points = [];
  for (let y = minYear; y <= maxYear; y += 1) {
    const x = y - minYear + 0.5;
    const count = counts.get(y) || 0;
    const yPos = 100 - (count / maxCount) * 92 - (count > 0 ? 6 : 0);
    points.push([x, yPos, y, count]);
  }

  // Stepped (not smoothed) outline: a flat segment spanning each year's full
  // width at that year's height, with a vertical connector at the boundary
  // between one year and the next — same shape as the "hist-hit" rects
  // below, which already span [i, i+1] per year.
  let stepD = `M 0,${points[0][1]}`;
  points.forEach(([, yPos], i) => {
    stepD += ` L ${i + 1},${yPos}`;
    if (i < points.length - 1) stepD += ` L ${i + 1},${points[i + 1][1]}`;
  });

  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "hist-area");
  area.setAttribute("d", `${stepD} L ${points.length},100 L 0,100 Z`);
  yearHistogramEl.appendChild(area);

  // The line is drawn as filled rects rather than a stroked path, to avoid
  // relying on vector-effect:non-scaling-stroke's join/miter geometry at
  // this chart's sharp step corners under such a non-uniformly stretched
  // viewBox (preserveAspectRatio="none", ~7x100 stretched to ~1400x44px) —
  // that combination has known cross-browser inconsistencies. Rects
  // sidestep stroking entirely — same reasoning as the hist-dot squares
  // below, which are rects instead of circles for the same underlying
  // scaling reason.
  const plotWidthPx = yearHistogramEl.parentElement.clientWidth || 1;
  const pxPerYearUnit = plotWidthPx / numYears;
  const pxPerHeightUnit = (yearHistogramEl.clientHeight || 44) / 100;
  const lineHalfThicknessY = 1 / pxPerHeightUnit; // ~1px above/below center
  const lineHalfThicknessX = 1 / pxPerYearUnit;

  function addLineSeg(x, y, width, height) {
    const seg = document.createElementNS(SVG_NS, "rect");
    seg.setAttribute("class", "hist-line");
    seg.setAttribute("x", x);
    seg.setAttribute("y", y);
    seg.setAttribute("width", width);
    seg.setAttribute("height", height);
    yearHistogramEl.appendChild(seg);
  }

  points.forEach(([, yPos], i) => {
    addLineSeg(i, yPos - lineHalfThicknessY, 1, lineHalfThicknessY * 2);
    if (i < points.length - 1) {
      const nextY = points[i + 1][1];
      const top = Math.min(yPos, nextY) - lineHalfThicknessY;
      const bottom = Math.max(yPos, nextY) + lineHalfThicknessY;
      addLineSeg(i + 1 - lineHalfThicknessX, top, lineHalfThicknessX * 2, bottom - top);
    }
  });

  points.forEach(([x, yPos, y, count]) => {
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.setAttribute("class", "hist-hit" + (yearFilter === y ? " hist-selected" : ""));
    hit.setAttribute("x", x - 0.5);
    hit.setAttribute("y", 0);
    hit.setAttribute("width", 1);
    hit.setAttribute("height", 100);
    const titleEl = document.createElementNS(SVG_NS, "title");
    titleEl.textContent = count > 0 ? `${y}: ${count} work${count === 1 ? "" : "s"}` : `${y}: none`;
    hit.appendChild(titleEl);
    hit.addEventListener("click", () => {
      yearFilter = yearFilter === y ? null : y;
      renderYearHistogram();
      applyFilter();
    });
    yearHistogramEl.appendChild(hit);

    if (count > 0) {
      // A small square rather than a circle — with preserveAspectRatio="none"
      // stretching x/y independently, a circle would render as an ellipse.
      const size = yearFilter === y ? 4 : 2.2;
      const dot = document.createElementNS(SVG_NS, "rect");
      dot.setAttribute("class", "hist-dot" + (yearFilter === y ? " active" : ""));
      dot.setAttribute("x", x - size / 2);
      dot.setAttribute("y", yPos - size / 2);
      dot.setAttribute("width", size);
      dot.setAttribute("height", size);
      yearHistogramEl.appendChild(dot);
    }
  });
}

function sortWorks(order) {
  const copy = works.slice();
  if (order === "date-desc" || order === "date-asc") {
    copy.sort((a, b) => {
      const ay = a.year || 0;
      const by = b.year || 0;
      return order === "date-desc" ? by - ay : ay - by;
    });
  } else if (order === "downloadable") {
    // Stable sort — keeps relevance order within each group, just floats
    // the no-DOI rows to the bottom instead of leaving them scattered.
    copy.sort((a, b) => (b.doi ? 1 : 0) - (a.doi ? 1 : 0));
  } else if (order === "citations") {
    copy.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  } else if (order === "journal") {
    // Group by journal name, alphabetically; works without a journal sink
    // to the bottom as their own group rather than scattering.
    copy.sort((a, b) => {
      const aj = a.journal || "￿";
      const bj = b.journal || "￿";
      return aj.localeCompare(bj);
    });
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
    const metaParts = [work.journal, work.year, citationText, work.doi || "no DOI found"].filter(Boolean);
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
// leaves displayWorks/selection/status ids untouched so downloads, sorting,
// and retry-failed all keep working off the full (unfiltered) index space.
function applyFilter() {
  const query = searchInput.value.trim().toLowerCase();
  const rows = listEl.querySelectorAll(".work-row");
  let visibleCount = 0;

  rows.forEach((row, i) => {
    const work = displayWorks[i];
    const title = work ? work.title.toLowerCase() : "";
    const matchesQuery = !query || title.includes(query);
    const matchesYear = yearFilter == null || (work && work.year === yearFilter);
    const matches = matchesQuery && matchesYear;
    row.style.display = matches ? "flex" : "none";
    if (matches) visibleCount += 1;
  });

  noMatchesEl.style.display = (query || yearFilter != null) && visibleCount === 0 ? "block" : "none";
}

searchInput.addEventListener("input", applyFilter);

// Cmd+F (Mac) / Ctrl+F (Windows/Linux) focuses our own filter box instead of
// the browser's native find bar — this page's search already does the job
// and native find can't see rows hidden by the year-histogram filter anyway.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same shared pause/cancel pattern as issue.js's downloadIssueGroup(), checked
// between every single DOI so a click takes effect within seconds.
let batchControl = null;

function startBatchControls() {
  batchControl = { paused: false, cancelled: false };
  batchRunControlsEl.style.display = "flex";
  btnBatchPause.textContent = "Pause";
  btnBatchPause.disabled = false;
  btnBatchCancel.disabled = false;
  return batchControl;
}

function endBatchControls() {
  batchRunControlsEl.style.display = "none";
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

async function runDownload(indices) {
  if (indices.length === 0) return;

  btnDownload.disabled = true;
  btnRetryFailed.disabled = true;
  btnSelectAll.disabled = true;
  btnSelectNone.disabled = true;

  progressBarWrap.style.display = "block";
  progressBar.style.width = "0%";

  const control = startBatchControls();

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

  let cancelled = false;
  for (const i of indices) {
    await waitWhilePaused(control);
    if (control.cancelled) { cancelled = true; break; }

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

    // Sequential, not parallel — same reasoning as the badge-check queue:
    // racing many DOIs against Sci-Hub mirrors at once makes them flaky.
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

  logLine(`SUMMARY | ${done} downloaded, ${failed} failed, ${indices.length} total${cancelled ? " (cancelled)" : ""}`);
  statusLineEl.textContent = cancelled
    ? `Cancelled — ${done} downloaded, ${failed} failed. Saved to ${outputDirOverride}`
    : `Done — ${done} downloaded, ${failed} failed. Saved to ${outputDirOverride}`;
  progressBar.style.width = "100%";
  setTimeout(() => { progressBarWrap.style.display = "none"; }, 600);
  endBatchControls();
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
  if (!authorName) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "No author name provided.";
    subtitleEl.textContent = "";
    return;
  }

  await resolveOutputPaths();
  initWatchAuthorButton();

  const [searchResp, logResp] = await Promise.all([
    new Promise((resolve) => chrome.runtime.sendMessage({ action: "searchAuthorWorks", author: authorName }, resolve)),
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
  affiliation = searchResp.affiliation || "";
  renderAuthorAvatar(searchResp.orcid || "");
  renderYearHistogram();
  renderWorks();
}

let affiliation = "";

function authorInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] || "" : "";
  return (first + last).toUpperCase();
}

function renderAuthorAvatar(orcid) {
  // author.html is a dedicated per-author tab (authorName never changes
  // after load), so unlike popup.js's prefetch panels there's no "page
  // moved on to a different DOI/author" race to guard against here.
  authorAvatarEl.style.display = "flex";
  authorAvatarEl.textContent = authorInitials(authorName); // shown until (if) a photo resolves, and kept as the fallback
  chrome.runtime.sendMessage({ action: "getAuthorAvatar", author: authorName, orcid: orcid || "" }, (resp) => {
    if (resp && resp.success && resp.avatar && resp.avatar.type === "photo" && resp.avatar.url) {
      const img = document.createElement("img");
      img.src = resp.avatar.url;
      img.alt = authorName;
      // Keep showing the initials (already in place) if the cached photo
      // URL ever stops resolving — no broken-image icon.
      img.addEventListener("error", () => {
        authorAvatarEl.textContent = authorInitials(authorName);
      });
      authorAvatarEl.textContent = "";
      authorAvatarEl.appendChild(img);
    }
    // Anything else (no success, or type "initials") — the initials placeholder already in place is the final state.
  });
}

if (authorName) {
  externalLinksEl.style.display = "flex";
}

btnScholar.addEventListener("click", () => {
  const url = "https://scholar.google.com/scholar?q=" + encodeURIComponent(`"${authorName}"`);
  chrome.tabs.create({ url });
});

btnInstitution.addEventListener("click", () => {
  const query = affiliation ? `${authorName} ${affiliation} faculty page` : `${authorName} university faculty page`;
  const url = "https://www.google.com/search?q=" + encodeURIComponent(query);
  chrome.tabs.create({ url });
});

btnCollaboratorsPage.addEventListener("click", () => {
  const url = chrome.runtime.getURL("collaborators.html") + "?author=" + encodeURIComponent(authorName);
  chrome.tabs.create({ url });
});

document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  window.toggleTheme();
});

init();
