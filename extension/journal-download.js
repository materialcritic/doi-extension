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
const retryMissingWrapEl = document.getElementById("retry-missing-wrap");
const retryMissingEl = document.getElementById("retry-missing");
const retryMissingLabelEl = document.getElementById("retry-missing-label");
const scanWarningEl = document.getElementById("scan-warning");

document.getElementById("btn-theme-toggle")?.addEventListener("click", () => window.toggleTheme());

const params = new URLSearchParams(window.location.search);
const issn = params.get("issn") || "";
const journal = params.get("journal") || "";

journalTitleEl.textContent = journal ? `Download Entire Journal — ${journal}` : "Download Entire Journal";

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

function issueFolderFor(group) {
  const folderName = sanitizeFolderName(`${journal || issn} Vol ${group.volume} Issue ${group.issueNum || "unknown"}`, "issue");
  return joinOutputPath(baseOutputDir, folderName);
}

let baseOutputDir = null;
let journalGroups = []; // every issue and its works; survives re-renders
let allGroups = []; // the rendered sections for journalGroups
let rowsByDoi = new Map();
let totalWorks = 0; // articles currently ticked
let totalDone = 0; // this run
let totalFailed = 0; // this run
let inFlightTotal = 0;
let runState = "idle"; // "idle" | "running"
let lastRunNote = "";

const control = { paused: false, cancelled: false };
const pendingLogs = new Set();

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
  // Browser downloads waiting on a Save dialog would otherwise hold their
  // slot for up to a minute after Cancel.
  chrome.runtime.sendMessage({ action: "cancelBrowserDownloads" }, () => void chrome.runtime.lastError);
  updateStatusText();
});

function updateStatusText(extra) {
  let text;
  if (extra) {
    text = extra;
  } else if (runState === "running") {
    text = `${totalDone} downloaded, ${totalFailed} failed of ${totalWorks} queued`;
    if (inFlightTotal) text += ` — ${inFlightTotal} in progress`;
  } else {
    text = (lastRunNote ? lastRunNote + " " : "") + `${totalWorks} ticked to download.`;
  }
  const state = control.cancelled
    ? " — cancelling, letting what's in progress finish…"
    : control.paused
      ? " — paused (in-progress downloads will finish)"
      : "";
  statusTextEl.textContent = text + state;
  const pct = runState === "running" && totalWorks > 0 ? Math.round(((totalDone + totalFailed) / totalWorks) * 100) : 0;
  progressBarEl.style.width = pct + "%";
}

// ---- What's already downloaded ---------------------------------------------

// Asks the native host what's actually on disk for every issue folder (see
// scan_issue_folder in doi_host.py): complete PDFs, renamed or not, cut-off
// files, and what each folder's own log says. Resolves { ok, error, priors,
// access } where `access` totals what the operating system wouldn't let the
// host read (macOS can allow Chrome into ~/Downloads yet refuse the helper
// process), because a scan that couldn't read half of what it looked at is
// not the same as one that found nothing.
async function scanPriorDownloads(groups) {
  const issues = groups.map((g) => ({ folder: issueFolderFor(g), dois: g.works.map((w) => w.doi) }));
  const priors = new Map();
  const access = { blocked_files: 0, unreadable_logs: 0, unreadable_rename_logs: 0, python: "", python_version: "" };
  for (const chunk of chunkIssuesForScan(issues)) {
    const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ action: "scanIssueDownloads", issues: chunk }, resolve));
    if (!resp || !resp.success) {
      return { ok: false, error: (resp && resp.error) || "no response from the native host", priors, access };
    }
    for (const [doi, state] of Object.entries(resp.states || {})) {
      priors.set(doi, { state, detail: (resp.details || {})[doi] || "" });
    }
    const a = resp.access;
    if (a) {
      access.blocked_files += Number(a.blocked_files) || 0;
      access.unreadable_logs += Number(a.unreadable_logs) || 0;
      access.unreadable_rename_logs += Number(a.unreadable_rename_logs) || 0;
      access.python = a.python || access.python;
      access.python_version = a.python_version || access.python_version;
    }
  }
  return { ok: true, priors, access };
}

// Decides, for every article, whether it starts ticked. `priors` is null when
// the scan failed; then only what this page itself saw succeed or fail is known.
function applyPriors(groups, priors) {
  groups.forEach((group) => {
    group.started = false;
    group.works.forEach((work) => {
      delete work.started;
      delete work.inFlight;
      let plan = null;
      const found = priors && priors.get(work.doi);
      if (found) plan = resumePlan(found.state, found.detail);
      else if (!priors && work.sessionDone) plan = resumePlan("ok");
      else if (!priors && work.sessionFailed !== undefined) plan = resumePlan("failed", work.sessionFailed);
      work.plan = plan;
      work.removed = plan ? !plan.selected : false;
      if (plan && plan.prior === "missing") work.removed = !retryMissingEl.checked;
    });
  });
}

function isDefaultSelected(work) {
  return !work.plan || work.plan.selected || (work.plan.prior === "missing" && retryMissingEl.checked);
}

function refreshRowLabel(work, statusEl) {
  const plan = work.plan;
  if (!plan) return;
  if (!work.removed && !plan.selected) {
    // Ticked by hand even though it was skipped by default.
    statusEl.textContent = plan.prior === "done" ? "Will download again" : "Will retry";
    statusEl.className = "work-status warn";
  } else {
    statusEl.textContent = plan.label;
    statusEl.className = "work-status " + plan.cls;
  }
}

function journalSummary() {
  const c = { total: 0, done: 0, redo: 0, retry: 0, missing: 0 };
  journalGroups.forEach((g) =>
    g.works.forEach((w) => {
      c.total += 1;
      if (w.plan) c[w.plan.prior] += 1;
    })
  );
  const fresh = c.total - c.done - c.redo - c.retry - c.missing;
  const parts = [];
  if (c.done) parts.push(`${c.done} already downloaded`);
  if (c.redo) parts.push(`${c.redo} incomplete`);
  if (c.retry) parts.push(`${c.retry} failed last time`);
  if (c.missing) parts.push(`${c.missing} not found last time`);
  parts.push(`${fresh} not tried yet`);
  const issues = journalGroups.length;
  return {
    text: `${issues} issue${issues === 1 ? "" : "s"}, ${c.total} article${c.total === 1 ? "" : "s"} — ${parts.join(", ")}`,
    missing: c.missing,
    anyPrior: c.done + c.redo + c.retry + c.missing > 0,
  };
}

function refreshHeader() {
  const summary = journalSummary();
  subtitleEl.textContent = summary.text;
  totalsTextEl.textContent = summary.text;
  retryMissingWrapEl.style.display = runState === "idle" && summary.missing > 0 ? "block" : "none";
  const n = summary.missing;
  retryMissingLabelEl.textContent = `Also retry the ${n} paper${n === 1 ? "" : "s"} that ${n === 1 ? "wasn't" : "weren't"} found last time`;
}

function updateStartButton() {
  if (runState === "running") return;
  btnStart.disabled = totalWorks === 0;
  btnStart.textContent =
    totalWorks === 0
      ? "Nothing left to download"
      : journalSummary().anyPrior
        ? `Resume Download (${totalWorks} left)`
        : `Start Download (${totalWorks})`;
}

function showScanWarning(scan) {
  scanWarningEl.title = "";
  if (!scan.ok) {
    scanWarningEl.style.display = "block";
    scanWarningEl.textContent =
      `Couldn't check what's already downloaded (${scan.error}). Everything is ticked, so papers you already have would be downloaded again — untick any you don't want.`;
    return;
  }
  const a = scan.access || {};
  const refused = (a.blocked_files || 0) + (a.unreadable_logs || 0) + (a.unreadable_rename_logs || 0);
  if (refused === 0) {
    scanWarningEl.style.display = "none";
    return;
  }
  const helper = a.python_version ? ` (Python ${a.python_version})` : "";
  scanWarningEl.style.display = "block";
  scanWarningEl.textContent =
    `macOS is stopping the download helper${helper} from opening some of your downloaded files, so this check is going by the download logs, not by what's on disk. ` +
    "It can't spot damaged PDFs, and a paper that was renamed but isn't in a log may be downloaded again — untick any you already have. " +
    "The README's Troubleshooting section explains the fix.";
  scanWarningEl.title =
    `Refused by macOS: ${a.blocked_files || 0} PDF(s), ${a.unreadable_logs || 0} folder log(s), ${a.unreadable_rename_logs || 0} rename log(s). Helper: ${a.python || "unknown"}`;
}

retryMissingEl.addEventListener("change", () => {
  const on = retryMissingEl.checked;
  allGroups.forEach(({ rowRefs }) =>
    rowRefs.forEach(({ work, checkbox, row, statusEl }) => {
      if (work.started || !work.plan || work.plan.prior !== "missing") return;
      work.removed = !on;
      checkbox.checked = on;
      row.classList.toggle("row-skip", !on);
      refreshRowLabel(work, statusEl);
    })
  );
  recomputeSelection(allGroups);
});

// ---- Rendering --------------------------------------------------------------

function fetchWorkAbstract(doi) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getWorkAbstract", doi }, (resp) => {
      resolve(resp && resp.success ? resp.abstract : null);
    });
  });
}

// Recomputes the overall queued-total from every group's current checkbox
// selections (works.removed === true means "unchecked, skip"), then
// refreshes the progress text and each group's idle label/checkbox state.
// Called after every checkbox toggle rather than incrementally tracked, so
// repeatedly checking/unchecking the same row never drifts out of sync.
function recomputeSelection(groups) {
  totalWorks = groups.reduce((sum, { group }) => sum + group.works.filter((w) => !w.removed).length, 0);
  updateStatusText();
  updateStartButton();
  groups.forEach(({ refreshIdleLabel, refreshGroupCheckbox }) => {
    refreshIdleLabel();
    refreshGroupCheckbox();
  });
}

function buildGroupRow(work, onToggle) {
  const row = document.createElement("div");
  row.className = "work-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "row-checkbox";
  checkbox.checked = !work.removed;
  checkbox.title = "Include this article in the download";
  row.classList.toggle("row-skip", !!work.removed);

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
  if (work.plan) {
    refreshRowLabel(work, status);
    if (work.plan.tip) status.title = work.plan.tip;
  }

  checkbox.addEventListener("change", () => {
    work.removed = !checkbox.checked;
    row.classList.toggle("row-skip", !checkbox.checked);
    refreshRowLabel(work, status);
    onToggle();
  });

  row.appendChild(checkbox);
  row.appendChild(title);
  row.appendChild(status);
  return { row, statusEl: status, checkbox };
}

function buildGroupSection(group) {
  const details = document.createElement("details");
  details.className = "issue-group";

  const summary = document.createElement("summary");

  const groupCheckbox = document.createElement("input");
  groupCheckbox.type = "checkbox";
  groupCheckbox.className = "group-checkbox";
  groupCheckbox.title = "Include this whole issue in the download";
  // Toggling the summary's own <details> open/closed shouldn't fire just
  // because the user clicked the checkbox inside it.
  groupCheckbox.addEventListener("click", (e) => e.stopPropagation());

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
    if (group.started) return;
    const n = remainingCount();
    const done = group.works.filter((w) => w.plan && w.plan.prior === "done").length;
    if (done === group.works.length) {
      status.className = "group-status ok";
      status.textContent = "all downloaded ✓";
      return;
    }
    status.className = "group-status";
    status.textContent = `${n} to download` + (done ? ` · ${done} already done` : "");
  }

  // Reflects the current mix of per-article checkboxes: all checked, all
  // unchecked, or (via the indeterminate visual state) some of each.
  function refreshGroupCheckbox() {
    const n = remainingCount();
    groupCheckbox.checked = n > 0;
    groupCheckbox.indeterminate = n > 0 && n < group.works.length;
  }

  groupCheckbox.addEventListener("change", () => {
    const checked = groupCheckbox.checked;
    rowRefs.forEach(({ work, checkbox, row, statusEl }) => {
      if (work.started) return; // too late to toggle one already in flight/done
      // Ticking the issue selects what a run would normally do; papers that
      // are already downloaded stay out unless ticked one by one.
      work.removed = !(checked && isDefaultSelected(work));
      checkbox.checked = !work.removed;
      row.classList.toggle("row-skip", work.removed);
      refreshRowLabel(work, statusEl);
    });
    recomputeSelection(allGroups);
  });

  summary.appendChild(groupCheckbox);
  summary.appendChild(chevron);
  summary.appendChild(label);
  summary.appendChild(status);
  details.appendChild(summary);

  const workList = document.createElement("div");
  workList.className = "group-works";

  const rowRefs = group.works.map((work) => {
    const { row, statusEl, checkbox } = buildGroupRow(work, () => recomputeSelection(allGroups));
    workList.appendChild(row);
    return { work, statusEl, checkbox, row };
  });

  details.appendChild(workList);
  return { details, statusEl: status, rowRefs, refreshIdleLabel, refreshGroupCheckbox };
}

function renderGroups() {
  const openKeys = new Set(allGroups.filter(({ details }) => details.open).map(({ group }) => `${group.volume}|${group.issueNum}`));
  groupsEl.innerHTML = "";
  rowsByDoi = new Map();
  allGroups = journalGroups.map((group) => {
    const built = buildGroupSection(group);
    groupsEl.appendChild(built.details);
    if (openKeys.has(`${group.volume}|${group.issueNum}`)) built.details.open = true;
    built.rowRefs.forEach((ref) => rowsByDoi.set(ref.work.doi, ref));
    return { group, ...built };
  });
  recomputeSelection(allGroups);
  refreshHeader();
}

// ---- Running ----------------------------------------------------------------

const PHASE_TEXT = {
  browser: { label: "Downloading via browser…", cls: "active", tip: "Cloudflare blocked the usual route, so Chrome is fetching this one." },
  "save-dialog": {
    label: "Waiting for Chrome’s save dialog…",
    cls: "warn",
    tip: "Click Save in Chrome’s dialog — or turn off “Ask where to save each file before downloading” in chrome://settings/downloads so this runs unattended.",
  },
  tab: { label: "Waiting for a check in the new tab…", cls: "warn", tip: "A site wants you to complete a check in the tab that just opened." },
  "tab-background": {
    label: "Waiting for Cloudflare to clear…",
    cls: "warn",
    tip: "A site is running a Cloudflare check. It's open in a background tab; if it doesn't clear itself within about 45 seconds this paper is skipped and the site is left alone for a few minutes.",
  },
};

// The background reports when a download moves to a slower route, so a row
// waiting on a Save dialog says so instead of just looking stuck.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.action !== "downloadPhase") return;
  const ref = rowsByDoi.get(msg.doi);
  const text = PHASE_TEXT[msg.phase];
  if (!ref || !text || !ref.work.inFlight) return;
  ref.statusEl.textContent = text.label;
  ref.statusEl.className = "work-status " + text.cls;
  ref.statusEl.title = text.tip;
});

function appendIssueLog(logPath, line) {
  const promise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "appendLog", filepath: logPath, line }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  pendingLogs.add(promise);
  promise.finally(() => pendingLogs.delete(promise));
  return promise;
}

async function downloadGroup(group, groupStatusEl, rowRefs) {
  const outputDir = issueFolderFor(group);
  const logPath = joinOutputPath(outputDir, "download_log.txt");

  group.started = true;

  const queued = group.works.filter((w) => !w.removed).length;
  let done = 0;
  let failed = 0;

  groupStatusEl.className = "group-status active";
  groupStatusEl.textContent = `downloading 0/${queued}…`;

  let inFlight = 0;
  const showGroupProgress = () => {
    groupStatusEl.textContent = `${done + failed}/${queued} done, ${inFlight} downloading…`;
  };

  await runBatchPool(rowRefs, async ({ work, statusEl, checkbox }) => {
    if (work.removed) return; // user unchecked it before its turn came up

    await waitWhilePaused();
    if (control.cancelled) {
      statusEl.textContent = "Skipped";
      checkbox.disabled = true;
      return;
    }

    work.started = true; // too late to toggle once it's about to download
    work.inFlight = true;
    checkbox.disabled = true;
    statusEl.textContent = "Downloading…";
    statusEl.className = "work-status active";
    statusEl.removeAttribute("title");
    inFlight += 1;
    inFlightTotal += 1;
    showGroupProgress();
    updateStatusText();

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride: outputDir }, (resp) => {
        const result = resp && resp.result;
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        work.inFlight = false;
        inFlight -= 1;
        inFlightTotal -= 1;
        statusEl.removeAttribute("title");
        const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
        if (resp && resp.success && result && result.status === "ok") {
          done += 1;
          totalDone += 1;
          work.sessionDone = true;
          delete work.sessionFailed;
          const isOa = result.source === "open_access";
          statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
          statusEl.className = "work-status ok";
          appendIssueLog(logPath, `${timestamp} | SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}${isOa ? " | open_access" : ""}`);
        } else if (control.cancelled && /cancel/i.test(detail)) {
          // Stopped by the user's Cancel, not a real failure: leave no
          // FAILED line behind so it just shows as "not tried" next time.
          statusEl.textContent = "Cancelled";
          statusEl.className = "work-status dim";
        } else {
          failed += 1;
          totalFailed += 1;
          work.sessionFailed = detail;
          delete work.sessionDone;
          const status = result && result.status === "corrupt" ? "CORRUPT" : "FAILED";
          statusEl.textContent = status === "CORRUPT" ? "Corrupt" : "Failed";
          statusEl.className = "work-status err";
          statusEl.title = detail;
          appendIssueLog(logPath, `${timestamp} | ${status} | ${work.doi} | ${work.title} | ${detail}`);
        }
        showGroupProgress();
        updateStatusText();
        resolve();
      });
    });
  });

  groupStatusEl.textContent = `${done} downloaded, ${failed} failed`;
  groupStatusEl.className = "group-status " + (failed > 0 ? "err" : "ok");
}

async function refreshFromDisk() {
  const scan = await scanPriorDownloads(journalGroups);
  applyPriors(journalGroups, scan.ok ? scan.priors : null);
  renderGroups();
  showScanWarning(scan);
}

async function finishRun(wasCancelled) {
  updateStatusText(wasCancelled ? "Stopped — checking what's on disk…" : "Finished — checking what's on disk…");
  // Let every log line land first: the rescan reads them back.
  await Promise.all([...pendingLogs]);
  lastRunNote = `${wasCancelled ? "Stopped" : "Finished"}: ${totalDone} downloaded, ${totalFailed} failed this session.`;
  runState = "idle";
  control.paused = false;
  control.cancelled = false;
  btnPause.textContent = "Pause";
  btnPause.disabled = true;
  btnCancel.disabled = true;
  await refreshFromDisk();
}

async function runAllGroups(groups) {
  runState = "running";
  totalDone = 0;
  totalFailed = 0;
  control.paused = false;
  control.cancelled = false;
  // A fresh run starts with the browser-download safeguards reset.
  chrome.runtime.sendMessage({ action: "resetBrowserFallback" }, () => void chrome.runtime.lastError);
  refreshHeader();
  updateStatusText();

  for (const { group, details, statusEl, rowRefs } of groups) {
    await waitWhilePaused();
    if (control.cancelled) break;
    if (!group.works.some((w) => !w.removed)) continue; // nothing ticked here

    details.open = true;
    await downloadGroup(group, statusEl, rowRefs);
  }

  await finishRun(control.cancelled);
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

  if (!resp || !resp.success) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't fetch journal: " + (resp?.error || "unknown error");
    subtitleEl.textContent = "";
    return;
  }

  journalGroups = groupWorksByIssue(resp.works || []);
  if (journalGroups.length === 0) {
    loadingEl.style.display = "none";
    emptyEl.style.display = "block";
    subtitleEl.textContent = "";
    return;
  }

  subtitleEl.textContent = "Checking what's already downloaded…";
  const scan = await scanPriorDownloads(journalGroups);
  loadingEl.style.display = "none";
  applyPriors(journalGroups, scan.ok ? scan.priors : null);

  toolbarEl.style.display = "block";
  renderGroups();
  showScanWarning(scan);

  btnStart.addEventListener("click", () => {
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnCancel.disabled = false;
    runAllGroups(allGroups);
  });
}

init();
