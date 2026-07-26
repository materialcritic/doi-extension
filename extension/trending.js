const topicNameEl = document.getElementById("topic-name");
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
const abstractTooltipEl = document.getElementById("abstract-tooltip");
const sortSelect = document.getElementById("sort-select");
const windowSegEl = document.getElementById("window-seg");
const btnFollow = document.getElementById("btn-follow-topic");
const downloadableOnlyEl = document.getElementById("downloadable-only");

const params = new URLSearchParams(window.location.search);
const topicName = params.get("topic") || "";
const topicId = params.get("topicId") || "";
let windowMonths = parseInt(params.get("window"), 10) || 12;
let sortOrder = params.get("sort") || "velocity";

topicNameEl.textContent = topicName || "Unknown topic";
sortSelect.value = sortOrder;

// ---- abstract tooltip (same as author.js) ----
function showAbstractTooltip(text, x, y) {
  abstractTooltipEl.textContent = text;
  abstractTooltipEl.style.display = "block";
  const maxLeft = window.innerWidth - abstractTooltipEl.offsetWidth - 16;
  const maxTop = window.innerHeight - abstractTooltipEl.offsetHeight - 16;
  abstractTooltipEl.style.left = Math.max(8, Math.min(x + 14, maxLeft)) + "px";
  abstractTooltipEl.style.top = Math.max(8, Math.min(y + 14, maxTop)) + "px";
}
function hideAbstractTooltip() { abstractTooltipEl.style.display = "none"; }

function openSimilarSearch(work) {
  const keywords = extractKeywords(work.abstract || work.title || "");
  if (keywords.length === 0) return;
  const searchParams = new URLSearchParams({ q: keywords.join(" "), sourceTitle: work.title });
  chrome.tabs.create({ url: chrome.runtime.getURL("search.html") + "?" + searchParams.toString() });
}

// ---- settings / output paths (same pattern as author.js, topic-named folder) ----
function getSettings() {
  return new Promise((resolve) => chrome.storage.sync.get(["outputDir"], resolve));
}
function getDefaultOutputDir() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDefaultOutputDir" }, (resp) => {
      resolve(resp && resp.success && resp.path ? resp.path : "");
    });
  });
}
function sanitizeFolderName(name) {
  return name.replace(/[^\w\-. ]/g, "").trim().replace(/\s+/g, " ") || "topic";
}

let works = [];
let displayWorks = [];
const selectedKeys = new Set();
const alreadyDownloaded = new Set();
const failedKeys = new Set();
let outputDirOverride = null;
let logPath = null;

function workKey(work) { return work.doi || work.title; }

async function resolveOutputPaths() {
  const settings = await getSettings();
  let baseDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseDir) baseDir = (await getDefaultOutputDir()).replace(/\/+$/, "");
  outputDirOverride = `${baseDir}/${sanitizeFolderName(topicName)}`;
  logPath = `${outputDirOverride}/download_log.txt`;
}

function parseLog(content) {
  const statusByDOI = new Map();
  content.split("\n").forEach((line) => {
    const parts = line.split(" | ");
    if (parts.length < 3) return;
    if (parts[1] === "SUMMARY") return;
    statusByDOI.set(parts[2], parts[1]); // last occurrence wins
  });
  return statusByDOI;
}
function logLine(line) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  chrome.runtime.sendMessage({ action: "appendLog", filepath: logPath, line: `${timestamp} | ${line}` });
}

// ---- follow button (mirrors author.js's watch button) ----
let isFollowing = false;
function updateFollowButton() { btnFollow.textContent = isFollowing ? "★ Following This Topic" : "Follow This Topic"; }
async function initFollowButton() {
  const list = await new Promise((res) => chrome.runtime.sendMessage({ action: "getTopicWatchlist" }, res));
  const key = topicId || topicName;
  isFollowing = Array.isArray(list) && list.some((t) => (t.topicId || t.topic) === key);
  updateFollowButton();
  btnFollow.disabled = false;
}
btnFollow.addEventListener("click", () => {
  btnFollow.disabled = true;
  chrome.runtime.sendMessage(
    { action: "toggleTopicWatch", topic: topicName, topicId, windowMonths, sort: sortOrder },
    (resp) => {
      btnFollow.disabled = false;
      if (!resp || !resp.success) return;
      isFollowing = resp.watching;
      updateFollowButton();
    }
  );
});

// ---- velocity column helpers ----
function makeSparkline(spark) {
  const n = spark.length;
  if (n < 2) return "";
  const max = Math.max(...spark, 1);
  const w = 52, h = 14, pad = 1;
  const pts = spark.map((v, i) => {
    const x = pad + (i / (n - 1)) * (w - 2 * pad);
    const y = (h - pad) - (v / max) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><polyline points="${pts}" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
function relativeAge(days) {
  if (days == null) return "";
  if (days < 14) return `${Math.max(1, Math.round(days))} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(months / 12)} years ago`;
}

function sortWorks(order) {
  const copy = works.slice();
  if (order === "velocity") copy.sort((a, b) => (b.velocity || 0) - (a.velocity || 0));
  else if (order === "momentum") copy.sort((a, b) => (b.momentum || 0) - (a.momentum || 0));
  else if (order === "citations") copy.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  else if (order === "date-desc") copy.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return copy;
}
function sortLabel(o) {
  return o === "velocity" ? "citation velocity" : o === "momentum" ? "recent momentum" : o === "citations" ? "total citations" : "date";
}

function renderWorks() {
  if (displayWorks.length === 0) { emptyEl.style.display = "block"; listEl.style.display = "none"; return; }
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

    const vel = document.createElement("div");
    vel.className = "work-velocity";
    vel.innerHTML = `<span class="vp">▲ ${work.velocity.toFixed(1)}/mo</span>` + makeSparkline(work.spark || []);

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
    const citeText = `${work.citations} cite${work.citations === 1 ? "" : "s"}`;
    const metaParts = [citeText, work.journal, relativeAge(work.ageDays), work.doi || "no DOI"].filter(Boolean);
    meta.textContent = metaParts.join(" · ");
    meta.appendChild(document.createTextNode(" · "));
    const similar = document.createElement("span");
    similar.className = "find-similar";
    similar.textContent = "Find Similar";
    similar.addEventListener("click", () => openSimilarSearch(work));
    meta.appendChild(similar);

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
    row.appendChild(vel);
    row.appendChild(info);
    row.appendChild(status);
    listEl.appendChild(row);
  });

  applyFilter();
  updateDownloadButton();
}

function applyFilter() {
  const query = searchInput.value.trim().toLowerCase();
  const dlOnly = downloadableOnlyEl.checked;
  const rows = listEl.querySelectorAll(".work-row");
  let visible = 0;
  rows.forEach((row, i) => {
    const work = displayWorks[i];
    const title = work ? work.title.toLowerCase() : "";
    const matchesQuery = !query || title.includes(query);
    const matchesDl = !dlOnly || (work && work.doi);
    const matches = matchesQuery && matchesDl;
    row.style.display = matches ? "flex" : "none";
    if (matches) visible += 1;
  });
  noMatchesEl.style.display = (query || dlOnly) && visible === 0 ? "block" : "none";
}
searchInput.addEventListener("input", applyFilter);
downloadableOnlyEl.addEventListener("change", applyFilter);

document.addEventListener("keydown", (e) => {
  const modifier = navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
  if (modifier && e.key.toLowerCase() === "f") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
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
  if (e.target.checked) selectedKeys.add(workKey(work));
  else selectedKeys.delete(workKey(work));
  updateDownloadButton();
});
btnSelectAll.addEventListener("click", () => {
  displayWorks.forEach((work) => { if (work.doi) selectedKeys.add(workKey(work)); });
  renderWorks();
});
btnSelectNone.addEventListener("click", () => {
  displayWorks.forEach((work) => selectedKeys.delete(workKey(work)));
  renderWorks();
});
sortSelect.addEventListener("change", (e) => {
  sortOrder = e.target.value;
  displayWorks = sortWorks(sortOrder);
  renderWorks();
});
windowSegEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-window]");
  if (!btn) return;
  const m = parseInt(btn.dataset.window, 10);
  if (!m || m === windowMonths) return;
  windowMonths = m;
  windowSegEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.window, 10) === windowMonths));
  loadTrending();
});

// ---- batch download machinery (verbatim from author.js) ----
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
let batchControl = null;
function startBatchControls() {
  batchControl = { paused: false, cancelled: false };
  batchRunControlsEl.style.display = "flex";
  btnBatchPause.textContent = "Pause";
  btnBatchPause.disabled = false;
  btnBatchCancel.disabled = false;
  return batchControl;
}
function endBatchControls() { batchRunControlsEl.style.display = "none"; batchControl = null; }
async function waitWhilePaused(control) { while (control.paused && !control.cancelled) await sleep(300); }
btnBatchPause.addEventListener("click", () => {
  if (!batchControl) return;
  batchControl.paused = !batchControl.paused;
  btnBatchPause.textContent = batchControl.paused ? "Resume" : "Pause";
});
btnBatchCancel.addEventListener("click", () => {
  if (!batchControl) return;
  batchControl.cancelled = true;
  batchControl.paused = false;
  btnBatchPause.disabled = true;
  btnBatchCancel.disabled = true;
});

async function runDownload(indices) {
  if (indices.length === 0) return;
  btnDownload.disabled = true; btnRetryFailed.disabled = true;
  btnSelectAll.disabled = true; btnSelectNone.disabled = true;
  progressBarWrap.style.display = "block"; progressBar.style.width = "0%";
  const control = startBatchControls();

  let done = 0, failed = 0;
  const batchStart = Date.now();
  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
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
      etaText = ` — est. ${formatDuration(avgMs * (indices.length - completed))} remaining`;
    }
    statusLineEl.textContent = `Downloading ${completed + 1} of ${indices.length}…${etaText}`;

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride }, (resp) => {
        const result = resp && resp.result;
        if (resp && resp.success && result && result.status === "ok") {
          statusEl.textContent = "Downloaded ✓"; statusEl.className = "work-status ok";
          done += 1; alreadyDownloaded.add(work.doi);
          logLine(`SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
        } else if (resp && resp.success && result && result.status === "corrupt") {
          statusEl.textContent = "Corrupt file"; statusEl.className = "work-status err";
          failed += 1; failedKeys.add(workKey(work));
          logLine(`CORRUPT | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
        } else {
          statusEl.textContent = "Not found"; statusEl.className = "work-status err";
          failed += 1; failedKeys.add(workKey(work));
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
  btnSelectAll.disabled = false; btnSelectNone.disabled = false;
  btnRetryFailed.style.display = failedKeys.size > 0 ? "block" : "none";
  btnRetryFailed.disabled = false;
  btnRetryFailed.textContent = `Retry Failed (${failedKeys.size})`;
  btnOpenFolder.style.display = done > 0 ? "block" : btnOpenFolder.style.display;
  updateDownloadButton();
}
btnDownload.addEventListener("click", () => runDownload(getSelectedIndices()));
btnRetryFailed.addEventListener("click", () => {
  const indices = [];
  displayWorks.forEach((work, i) => { if (failedKeys.has(workKey(work))) indices.push(i); });
  runDownload(indices);
});
btnOpenFolder.addEventListener("click", () => {
  btnOpenFolder.disabled = true;
  chrome.runtime.sendMessage({ action: "openFolder", folder: outputDirOverride }, (resp) => {
    btnOpenFolder.disabled = false;
    if (!resp || !resp.success) statusLineEl.textContent = "Couldn't open folder: " + (resp?.error || "Unknown error");
  });
});

// ---- load / init ----
async function loadTrending() {
  loadingEl.style.display = "block";
  errorEl.style.display = "none"; emptyEl.style.display = "none"; listEl.style.display = "none";

  const resp = await new Promise((res) =>
    chrome.runtime.sendMessage({ action: "getTrendingWorks", topic: topicName, topicId, windowMonths }, res)
  );
  loadingEl.style.display = "none";

  if (!resp || !resp.success) {
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't load trending papers: " + (resp?.error || "Unknown error");
    subtitleEl.textContent = "";
    return;
  }

  works = resp.works || [];
  selectedKeys.clear();
  works.forEach((w) => { if (w.doi && !alreadyDownloaded.has(w.doi)) selectedKeys.add(workKey(w)); });
  displayWorks = sortWorks(sortOrder);
  subtitleEl.textContent = `${works.length} papers from the last ${windowMonths} months, ranked by ${sortLabel(sortOrder)}`;
  renderWorks();
}

async function init() {
  if (!topicName) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "No topic provided.";
    subtitleEl.textContent = "";
    return;
  }
  await resolveOutputPaths();
  initFollowButton();
  windowSegEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.window, 10) === windowMonths));

  const logResp = await new Promise((res) => chrome.runtime.sendMessage({ action: "readLog", filepath: logPath }, res));
  if (logResp && logResp.success && logResp.content) {
    const statusByDOI = parseLog(logResp.content);
    statusByDOI.forEach((status, doi) => { if (status === "SUCCESS") alreadyDownloaded.add(doi); });
  }
  await loadTrending();
}

document.getElementById("btn-theme-toggle").addEventListener("click", () => window.toggleTheme());
init();
