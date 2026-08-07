const pageTitleEl = document.getElementById("page-title");
const subtitleEl = document.getElementById("subtitle");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const btnSelectAll = document.getElementById("btn-select-all");
const btnSelectNone = document.getElementById("btn-select-none");
const btnStart = document.getElementById("btn-start");
const btnPause = document.getElementById("btn-pause");
const btnCancel = document.getElementById("btn-cancel");
const btnOpenFolder = document.getElementById("btn-open-folder");
const totalsTextEl = document.getElementById("totals-text");
const statusTextEl = document.getElementById("status-text");
const progressBarEl = document.getElementById("progress-bar");

document.getElementById("btn-theme-toggle")?.addEventListener("click", () => window.toggleTheme());

const params = new URLSearchParams(window.location.search);
const sourceTabId = Number(params.get("tabId"));
const sourceUrl = params.get("url") || "";
const sourceTitle = params.get("title") || "";
const isPdfSource = /\.pdf(?:[?#]|$)/i.test(sourceUrl);

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

const sourceLabel = sourceTitle || hostnameOf(sourceUrl) || "this page";
pageTitleEl.textContent = "Scan Page for DOIs";
// This initial text is only visible for an instant — the real "Downloading
// PDF from…"/"Reading local PDF…" progress line (native host, either the
// remote-fetch or local-file branch of scan_pdf_for_dois) overwrites it via
// the listener below almost immediately. Kept scheme-agnostic here since a
// PDF tab can be either a remote URL or a local file:// one.
subtitleEl.textContent = (isPdfSource ? "Reading the PDF… " : "Scanning ") + sourceLabel;
subtitleEl.title = sourceUrl;

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["outputDir"], resolve);
  });
}

// Pages can't know the user's home directory themselves — asks the native
// host, which resolves it via os.path.expanduser("~"), for the "leave
// output folder blank" default instead of hardcoding one machine's path.
function getDefaultOutputDir() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDefaultOutputDir" }, (resp) => {
      resolve(resp && resp.success && resp.path ? resp.path : "");
    });
  });
}

function fetchWorkAbstract(doi) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getWorkAbstract", doi }, (resp) => {
      resolve(resp && resp.success ? resp.abstract : null);
    });
  });
}

// Live progress lines forwarded from background.js while the scan itself
// (native-host PDF download/extraction, or the Crossref metadata backfill)
// is running — the same broadcast pattern popup.js listens for during a
// download, just consumed here instead since the popup that triggered this
// tab is long gone by the time any of this fires.
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress" && message.line) {
    subtitleEl.textContent = message.line;
  }
});

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

btnOpenFolder.addEventListener("click", () => {
  btnOpenFolder.disabled = true;
  chrome.runtime.sendMessage({ action: "openFolder", folder: baseOutputDir }, (resp) => {
    btnOpenFolder.disabled = false;
    if (!resp || !resp.success) {
      statusTextEl.textContent = "Couldn't open folder: " + (resp?.error || "Unknown error");
    }
  });
});

// Recomputes the queued total from every row's current checkbox state
// (entry.removed === true means "unchecked, skip"), rather than tracking an
// incremental delta — same reasoning as journal-download.js's
// recomputeSelection(): repeatedly toggling the same row can never drift
// out of sync this way.
let allRows = [];

function recomputeSelection() {
  totalWorks = allRows.filter(({ entry }) => !entry.removed).length;
  updateStatusText();
}

function buildRow(entry) {
  const row = document.createElement("div");
  row.className = "work-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "row-checkbox";
  // A DOI Crossref couldn't find at all is very likely a PDF-text-extraction
  // artifact (a truncated/garbled token, not a real paper) — see
  // extract_all_dois()'s docstring in scihub_download.py — so it starts
  // unchecked rather than assuming it's downloadable. Still shown, and
  // still checkable by hand, since it's occasionally just a very new DOI
  // Crossref hasn't indexed yet.
  checkbox.checked = !entry.notFound;
  entry.removed = !checkbox.checked;
  checkbox.title = "Include this DOI in the download";

  const main = document.createElement("div");
  main.className = "work-main";

  const title = document.createElement("div");
  title.className = "work-title clickable";
  title.textContent = entry.title || entry.doi;

  const meta = document.createElement("div");
  meta.className = "work-meta";
  const metaParts = [entry.author, entry.journal, entry.year].filter(Boolean);
  if (typeof entry.citations === "number") metaParts.push(`${entry.citations} citation${entry.citations === 1 ? "" : "s"}`);
  meta.textContent = metaParts.join(" • ");

  const doiLine = document.createElement("div");
  doiLine.className = "work-doi";
  doiLine.textContent = entry.doi;

  main.appendChild(title);
  if (metaParts.length) main.appendChild(meta);
  main.appendChild(doiLine);

  if (entry.notFound) {
    const flag = document.createElement("div");
    flag.className = "work-flag";
    flag.textContent = "⚠ Not found on Crossref — likely a partial/garbled match, unchecked by default.";
    main.appendChild(flag);
  } else if (entry.error) {
    const flag = document.createElement("div");
    flag.className = "work-flag";
    flag.textContent = "Couldn't fetch details (network error) — the DOI itself may still be fine.";
    main.appendChild(flag);
  }

  let abstractEl = null;
  title.addEventListener("click", async () => {
    if (abstractEl) {
      abstractEl.style.display = abstractEl.style.display === "none" ? "block" : "none";
      return;
    }
    abstractEl = document.createElement("div");
    abstractEl.className = "work-abstract-inline";
    abstractEl.textContent = "Loading abstract…";
    main.appendChild(abstractEl);

    const abstract = await fetchWorkAbstract(entry.doi);
    abstractEl.textContent = abstract || "No abstract available.";
  });

  const status = document.createElement("div");
  status.className = "work-status";
  status.textContent = "Pending";

  checkbox.addEventListener("change", () => {
    entry.removed = !checkbox.checked;
    row.classList.toggle("row-skip", !checkbox.checked);
    recomputeSelection();
  });
  row.classList.toggle("row-skip", !checkbox.checked);

  row.appendChild(checkbox);
  row.appendChild(main);
  row.appendChild(status);

  return { row, statusEl: status, checkbox, entry };
}

async function downloadSelected() {
  const folderName = sanitizeFolderName(`Page Scan - ${sourceLabel} (${new Date().toISOString().slice(0, 10)})`, "page-scan");
  const outputDir = joinOutputPath(baseOutputDir, folderName);
  const logPath = joinOutputPath(outputDir, "download_log.txt");

  for (const { entry, statusEl, checkbox, row } of allRows) {
    if (entry.removed) continue;

    await waitWhilePaused();
    if (control.cancelled) {
      statusEl.textContent = "Skipped";
      checkbox.disabled = true;
      continue;
    }

    checkbox.disabled = true;
    statusEl.textContent = "Downloading…";
    statusEl.className = "work-status active";

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "sendDOI", doi: entry.doi, outputDirOverride: outputDir }, (resp) => {
        const result = resp && resp.result;
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (resp && resp.success && result && result.status === "ok") {
          totalDone += 1;
          const isOa = result.source === "open_access";
          statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
          statusEl.className = "work-status ok";
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | SUCCESS | ${entry.doi} | ${entry.title || ""} | ${result.filepath || ""}${isOa ? " | open_access" : ""}`,
          });
          btnOpenFolder.style.display = "inline-block";
        } else {
          totalFailed += 1;
          const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
          const status = result && result.status === "corrupt" ? "CORRUPT" : "FAILED";
          statusEl.textContent = status === "CORRUPT" ? "Corrupt" : "Failed";
          statusEl.className = "work-status err";
          chrome.runtime.sendMessage({
            action: "appendLog",
            filepath: logPath,
            line: `${timestamp} | ${status} | ${entry.doi} | ${entry.title || ""} | ${detail}`,
          });
        }
        updateStatusText();
        resolve();
      });
    });
  }

  btnPause.disabled = true;
  btnCancel.disabled = true;
  updateStatusText(control.cancelled ? "Cancelled" : "Done");
}

btnSelectAll.addEventListener("click", () => {
  allRows.forEach(({ entry, checkbox, row }) => {
    if (entry.started) return;
    checkbox.checked = true;
    entry.removed = false;
    row.classList.remove("row-skip");
  });
  recomputeSelection();
});

btnSelectNone.addEventListener("click", () => {
  allRows.forEach(({ entry, checkbox, row }) => {
    if (entry.started) return;
    checkbox.checked = false;
    entry.removed = true;
    row.classList.add("row-skip");
  });
  recomputeSelection();
});

btnStart.addEventListener("click", () => {
  btnStart.disabled = true;
  btnSelectAll.disabled = true;
  btnSelectNone.disabled = true;
  btnPause.disabled = false;
  btnCancel.disabled = false;
  allRows.forEach(({ entry }) => { entry.started = true; });
  downloadSelected();
});

function scanPageForDOIs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: "scanPageForDOIs", tabId: sourceTabId, url: sourceUrl },
      (resp) => resolve(resp || { success: false, error: "No response from the extension." })
    );
  });
}

function resolveDoiList(dois) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "resolveDoiList", dois }, (resp) => resolve(resp || { success: false, error: "No response." }));
  });
}

async function init() {
  const settings = await getSettings();
  baseOutputDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseOutputDir) baseOutputDir = (await getDefaultOutputDir()).replace(/\/+$/, "");

  const scanResp = await scanPageForDOIs();
  if (!scanResp.success) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't scan this page: " + (scanResp.error || "unknown error");
    subtitleEl.textContent = "";
    return;
  }

  const rawDois = scanResp.dois || [];
  if (rawDois.length === 0) {
    loadingEl.style.display = "none";
    emptyEl.style.display = "block";
    subtitleEl.textContent = "";
    return;
  }

  subtitleEl.textContent = `Found ${rawDois.length} DOI${rawDois.length === 1 ? "" : "s"} — fetching paper details…`;

  const resolveResp = await resolveDoiList(rawDois);
  loadingEl.style.display = "none";

  const entries = resolveResp.success ? resolveResp.entries : rawDois.map((doi) => ({ doi, title: null, author: "", journal: "", year: null, citations: null, notFound: false, error: true }));

  allRows = entries.map((entry) => {
    const built = buildRow(entry);
    listEl.appendChild(built.row);
    return built;
  });

  totalWorks = allRows.filter(({ entry }) => !entry.removed).length;
  const summary = `${entries.length} DOI${entries.length === 1 ? "" : "s"} found on ${isPdfSource ? "this PDF" : "this page"} — ${sourceLabel}`;
  subtitleEl.textContent = summary;
  totalsTextEl.textContent = summary;

  toolbarEl.style.display = "block";
  updateStatusText();
}

init();
