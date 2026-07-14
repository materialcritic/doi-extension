const journalTitleEl = document.getElementById("journal-title");
const subtitleEl = document.getElementById("subtitle");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const emptyEl = document.getElementById("empty");
const groupsEl = document.getElementById("groups");
const toolbarEl = document.getElementById("toolbar");
const btnStart = document.getElementById("btn-start");
const btnPause = document.getElementById("btn-pause");
const btnCancel = document.getElementById("btn-cancel");
const totalsTextEl = document.getElementById("totals-text");
const statusTextEl = document.getElementById("status-text");
const progressBarEl = document.getElementById("progress-bar");

document.getElementById("btn-theme-toggle")?.addEventListener("click", () => window.toggleTheme());

const params = new URLSearchParams(window.location.search);
const issn = params.get("issn") || "";
const journal = params.get("journal") || "";

journalTitleEl.textContent = journal ? `Download Entire Journal — ${journal}` : "Download Entire Journal";

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

function groupWorksByIssue(works) {
  const groups = new Map();
  works.forEach((w) => {
    if (!w.doi || !w.volume) return; // nothing to file this under without a volume
    const key = `${w.volume}|${w.issue || ""}`;
    if (!groups.has(key)) groups.set(key, { volume: w.volume, issueNum: w.issue || "", year: w.year || null, works: [] });
    const group = groups.get(key);
    group.works.push(w);
    // Not every work in an issue carries a year (some Crossref records omit
    // published-print/online) — take the first one that has it.
    if (!group.year && w.year) group.year = w.year;
  });
  return Array.from(groups.values()).sort((a, b) => {
    const volDiff = Number(a.volume) - Number(b.volume);
    if (volDiff) return volDiff;
    return Number(a.issueNum || 0) - Number(b.issueNum || 0);
  });
}

let baseOutputDir = null;
let totalWorks = 0;
let totalDone = 0;
let totalFailed = 0;

const control = { paused: false, cancelled: false };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhilePaused() {
  while (control.paused && !control.cancelled) {
    await sleep(300);
  }
}

btnPause.addEventListener("click", () => {
  control.paused = !control.paused;
  btnPause.textContent = control.paused ? "Resume" : "Pause";
  updateStatusText();
});

btnCancel.addEventListener("click", () => {
  control.cancelled = true;
  control.paused = false; // don't leave it stuck inside waitWhilePaused
  btnPause.disabled = true;
  btnCancel.disabled = true;
  updateStatusText();
});

function updateStatusText(extra) {
  const base = `${totalDone} downloaded, ${totalFailed} failed of ${totalWorks} total`;
  const state = control.cancelled ? " — cancelling…" : control.paused ? " — paused" : "";
  statusTextEl.textContent = (extra || base) + state;
  const pct = totalWorks > 0 ? Math.round(((totalDone + totalFailed) / totalWorks) * 100) : 0;
  progressBarEl.style.width = pct + "%";
}

// Lets the user drop a specific article before it's downloaded. Only
// meaningful while it's still Pending — once a download is in flight the
// request can't be un-sent, and there's nothing left to remove once it's
// finished (successfully or not).
function fetchWorkAbstract(doi) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getWorkAbstract", doi }, (resp) => {
      resolve(resp && resp.success ? resp.abstract : null);
    });
  });
}

function buildGroupRow(work, onRemove) {
  const row = document.createElement("div");
  row.className = "work-row";

  const title = document.createElement("div");
  title.className = "work-title clickable";
  title.textContent = work.title;
  title.title = work.title;

  let abstractEl = null;
  title.addEventListener("click", async () => {
    if (abstractEl) {
      // Already fetched (or in flight) — just toggle visibility.
      abstractEl.style.display = abstractEl.style.display === "none" ? "block" : "none";
      return;
    }
    abstractEl = document.createElement("div");
    abstractEl.className = "work-abstract-inline";
    abstractEl.textContent = "Loading abstract…";
    row.appendChild(abstractEl);

    const abstract = await fetchWorkAbstract(work.doi);
    abstractEl.textContent = abstract || "No abstract available.";
  });

  const status = document.createElement("div");
  status.className = "work-status";
  status.textContent = "Pending";

  const removeBtn = document.createElement("button");
  removeBtn.className = "row-remove-btn";
  removeBtn.title = "Don't download this article";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => {
    work.removed = true;
    status.textContent = "Removed";
    status.className = "work-status removed";
    removeBtn.style.display = "none";
    onRemove();
  });

  row.appendChild(title);
  row.appendChild(status);
  row.appendChild(removeBtn);
  return { row, statusEl: status, removeBtn };
}

function buildGroupSection(group) {
  const details = document.createElement("details");
  details.className = "issue-group";

  const summary = document.createElement("summary");

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "▶";

  const label = document.createElement("span");
  label.className = "group-label";
  label.textContent = `Vol. ${group.volume}, Issue ${group.issueNum || "—"}` + (group.year ? ` (${group.year})` : "");

  const status = document.createElement("span");
  status.className = "group-status";

  function remainingCount() {
    return group.works.filter((w) => !w.removed).length;
  }

  function refreshIdleLabel() {
    // Only meaningful before this group's download has started — once it's
    // running or finished, downloadGroup() owns groupStatusEl's text.
    if (!group.started) {
      const n = remainingCount();
      status.textContent = `${n} work${n === 1 ? "" : "s"}`;
    }
  }
  refreshIdleLabel();

  summary.appendChild(chevron);
  summary.appendChild(label);
  summary.appendChild(status);
  details.appendChild(summary);

  const workList = document.createElement("div");
  workList.className = "group-works";

  const rowRefs = group.works.map((work) => {
    const { row, statusEl, removeBtn } = buildGroupRow(work, () => {
      totalWorks -= 1;
      updateStatusText();
      refreshIdleLabel();
    });
    workList.appendChild(row);
    return { work, statusEl, removeBtn };
  });

  details.appendChild(workList);
  return { details, statusEl: status, rowRefs };
}

async function downloadGroup(group, groupStatusEl, rowRefs) {
  const folderName = sanitizeFolderName(`${journal || issn} Vol ${group.volume} Issue ${group.issueNum || "unknown"}`);
  const outputDir = `${baseOutputDir}/${folderName}`;
  const logPath = `${outputDir}/download_log.txt`;

  group.started = true;

  const queued = group.works.filter((w) => !w.removed).length;
  let done = 0;
  let failed = 0;

  groupStatusEl.className = "group-status active";
  groupStatusEl.textContent = `downloading 0/${queued}…`;

  for (const { work, statusEl, removeBtn } of rowRefs) {
    if (work.removed) continue; // user dropped it before its turn came up

    await waitWhilePaused();
    if (control.cancelled) {
      statusEl.textContent = "Skipped";
      removeBtn.style.display = "none";
      continue;
    }

    removeBtn.style.display = "none"; // too late to remove once it's about to download
    statusEl.textContent = "Downloading…";
    statusEl.className = "work-status active";
    groupStatusEl.textContent = `downloading ${done + failed + 1}/${queued}…`;

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride: outputDir }, (resp) => {
        const result = resp && resp.result;
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (resp && resp.success && result && result.status === "ok") {
          done += 1;
          totalDone += 1;
          const isOa = result.source === "open_access";
          statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
          statusEl.className = "work-status ok";
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}${isOa ? " | open_access" : ""}`,
          });
        } else {
          failed += 1;
          totalFailed += 1;
          const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
          const status = result && result.status === "corrupt" ? "CORRUPT" : "FAILED";
          statusEl.textContent = status === "CORRUPT" ? "Corrupt" : "Failed";
          statusEl.className = "work-status err";
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | ${status} | ${work.doi} | ${work.title} | ${detail}`,
          });
        }
        updateStatusText();
        resolve();
      });
    });
  }

  groupStatusEl.textContent = `${done} downloaded, ${failed} failed`;
  groupStatusEl.className = "group-status " + (failed > 0 ? "err" : "ok");
}

async function runAllGroups(groups) {
  for (const { group, details, statusEl, rowRefs } of groups) {
    await waitWhilePaused();
    if (control.cancelled) break;

    details.open = true;
    await downloadGroup(group, statusEl, rowRefs);
  }

  btnPause.disabled = true;
  btnCancel.disabled = true;
  updateStatusText(control.cancelled ? "Cancelled" : "Done");
}

async function init() {
  if (!issn) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Missing journal ISSN.";
    subtitleEl.textContent = "";
    return;
  }

  const settings = await getSettings();
  baseOutputDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseOutputDir) baseOutputDir = (await getDefaultOutputDir()).replace(/\/+$/, "");

  const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "getAllJournalWorks", issn }, resolve));

  loadingEl.style.display = "none";

  if (!resp || !resp.success) {
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't fetch journal: " + (resp?.error || "unknown error");
    subtitleEl.textContent = "";
    return;
  }

  const groups = groupWorksByIssue(resp.works || []);
  if (groups.length === 0) {
    emptyEl.style.display = "block";
    subtitleEl.textContent = "";
    return;
  }

  totalWorks = groups.reduce((sum, g) => sum + g.works.length, 0);
  const totalsSummary = `${groups.length} issue${groups.length === 1 ? "" : "s"} found — ${totalWorks} downloadable article${totalWorks === 1 ? "" : "s"} total`;
  subtitleEl.textContent = totalsSummary;
  // Also shown in the sticky toolbar (unlike the header subtitle, this stays
  // visible while scrolling through a long issue list).
  totalsTextEl.textContent = totalsSummary;

  const built = groups.map((group) => {
    const { details, statusEl, rowRefs } = buildGroupSection(group);
    groupsEl.appendChild(details);
    return { group, details, statusEl, rowRefs };
  });

  toolbarEl.style.display = "block";
  updateStatusText();

  btnStart.addEventListener("click", () => {
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnCancel.disabled = false;
    runAllGroups(built);
  });
}

init();
