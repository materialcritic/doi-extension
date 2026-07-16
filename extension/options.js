// Shared shimmer placeholder for panels backed by a native-host round trip
// or a Crossref/API fetch, so a slow load shows shaped content instead of
// blank space or a single static "Loading…" line.
function skeletonRowsHtml(n, labelWidth = "40%", valueWidth = "18%") {
  return Array.from({ length: n })
    .map(
      () =>
        `<div class="skeleton-row"><div class="skeleton-bar" style="width: ${labelWidth};"></div><div class="skeleton-bar" style="width: ${valueWidth};"></div></div>`
    )
    .join("");
}

const outputDirEl = document.getElementById("output-dir");
const pythonBinEl = document.getElementById("python-bin");
const scriptPathEl = document.getElementById("script-path");
const mirrorsEl = document.getElementById("mirrors");
const unpaywallEmailEl = document.getElementById("unpaywall-email");
const savedEl = document.getElementById("saved");

function load() {
  chrome.storage.sync.get(["outputDir", "pythonBin", "scriptPath", "mirrors", "unpaywallEmail"], (settings) => {
    outputDirEl.value = settings.outputDir || "";
    pythonBinEl.value = settings.pythonBin || "";
    scriptPathEl.value = settings.scriptPath || "";
    mirrorsEl.value = (settings.mirrors || []).join("\n");
    unpaywallEmailEl.value = settings.unpaywallEmail || "";
  });
}

function save() {
  const mirrors = mirrorsEl.value
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean);

  chrome.storage.sync.set(
    {
      outputDir: outputDirEl.value.trim(),
      pythonBin: pythonBinEl.value.trim(),
      scriptPath: scriptPathEl.value.trim(),
      mirrors,
      unpaywallEmail: unpaywallEmailEl.value.trim(),
    },
    () => {
      savedEl.classList.add("visible");
      setTimeout(() => savedEl.classList.remove("visible"), 1500);
    }
  );
}

function reset() {
  chrome.storage.sync.remove(["outputDir", "pythonBin", "scriptPath", "mirrors", "unpaywallEmail"], load);
}

document.getElementById("btn-save").addEventListener("click", save);
document.getElementById("btn-reset").addEventListener("click", reset);

const COMMAND_LABELS = {
  "download-current": "Download current paper",
  "search-google-current": "Search Google for current paper",
};

function loadShortcuts() {
  const container = document.getElementById("shortcuts-list");
  chrome.commands.getAll((commands) => {
    container.innerHTML = "";
    commands.forEach((cmd) => {
      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;

      const key = document.createElement("span");
      key.className = "row-value";
      key.textContent = cmd.shortcut || "Not set";
      if (!cmd.shortcut) key.style.opacity = "0.6";

      row.appendChild(label);
      row.appendChild(key);
      container.appendChild(row);
    });
  });
}

document.getElementById("btn-open-shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

const NON_BINDABLE_KEYS = ["Shift", "Control", "Alt", "Meta", "Tab", "CapsLock"];

function loadPopupShortcuts() {
  const container = document.getElementById("popup-shortcuts-list");
  chrome.storage.sync.get(["popupShortcuts"], (settings) => {
    const overrides = settings.popupShortcuts || {};
    container.innerHTML = "";

    POPUP_SHORTCUT_ACTIONS.forEach((action) => {
      const effective = overrides[action.id] !== undefined ? overrides[action.id] : action.defaultKey;

      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = action.label;

      const right = document.createElement("span");
      right.className = "row-right";

      const keyBadge = document.createElement("span");
      keyBadge.className = "key-badge";
      keyBadge.textContent = effective ? effective.toUpperCase() : "Not set";

      const recordBtn = document.createElement("button");
      recordBtn.className = "secondary";
      recordBtn.textContent = "Change";
      recordBtn.addEventListener("click", () => recordPopupShortcut(action.id, keyBadge, recordBtn));

      right.appendChild(keyBadge);
      right.appendChild(recordBtn);
      row.appendChild(label);
      row.appendChild(right);
      container.appendChild(row);
    });
  });
}

function recordPopupShortcut(actionId, keyBadge, recordBtn) {
  keyBadge.textContent = "Press a key…";
  recordBtn.disabled = true;

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (NON_BINDABLE_KEYS.includes(e.key)) return;

    if (e.key === "Escape") {
      cleanup();
      loadPopupShortcuts();
      return;
    }

    const key = e.key.toLowerCase();
    chrome.storage.sync.get(["popupShortcuts"], (settings) => {
      const overrides = settings.popupShortcuts || {};

      // If another action already holds this key (whether its default or a
      // prior override), free it so the same key never fires two buttons.
      POPUP_SHORTCUT_ACTIONS.forEach((a) => {
        if (a.id === actionId) return;
        const effective = overrides[a.id] !== undefined ? overrides[a.id] : a.defaultKey;
        if (effective === key) overrides[a.id] = "";
      });

      overrides[actionId] = key;
      chrome.storage.sync.set({ popupShortcuts: overrides }, () => {
        cleanup();
        loadPopupShortcuts();
      });
    });
  }

  function cleanup() {
    document.removeEventListener("keydown", onKey, true);
    recordBtn.disabled = false;
  }

  document.addEventListener("keydown", onKey, true);
}

document.getElementById("btn-reset-popup-shortcuts").addEventListener("click", () => {
  chrome.storage.sync.remove("popupShortcuts", loadPopupShortcuts);
});

const SPARKLINE_W = 60;
const SPARKLINE_H = 20;

function buildSparkline(history) {
  if (!history || history.length < 2) return null;

  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;

  const points = history.map((ms, i) => {
    const x = (i / (history.length - 1)) * SPARKLINE_W;
    const y = SPARKLINE_H - ((ms - min) / range) * SPARKLINE_H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", SPARKLINE_W);
  svg.setAttribute("height", SPARKLINE_H);
  svg.setAttribute("viewBox", `0 0 ${SPARKLINE_W} ${SPARKLINE_H}`);
  svg.style.flexShrink = "0";
  svg.title = `Last ${history.length} checks: ${min}–${max}ms`;

  const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyline.setAttribute("points", points);
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "var(--accent)");
  polyline.setAttribute("stroke-width", "1.5");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("stroke-linecap", "round");

  svg.appendChild(polyline);
  return svg;
}

function loadMirrorHealth() {
  const container = document.getElementById("mirror-health-list");
  container.innerHTML = skeletonRowsHtml(4, "45%", "25%");

  chrome.runtime.sendMessage({ action: "getMirrorHealth" }, (resp) => {
    if (!resp || !resp.success) {
      container.innerHTML = `<div class="hint">Couldn't load mirror status: ${escapeHtml(resp?.error || "Unknown error")}</div>`;
      return;
    }

    const mirrors = (resp.mirrors || []).sort((a, b) => b.fail_count - a.fail_count);
    if (mirrors.length === 0) {
      container.innerHTML = '<div class="hint">No mirror data yet — run a download or check first.</div>';
      return;
    }

    container.innerHTML = "";
    mirrors.forEach((m) => {
      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-value";
      label.textContent = m.url;

      const latencySuffix = m.last_latency_ms != null ? ` · ${m.last_latency_ms}ms` : "";

      const right = document.createElement("span");
      right.className = "row-right";

      const status = document.createElement("span");
      if (m.cooling_down) {
        status.textContent = `Cooling down (${m.cooldown_remaining_min} min left, ${m.fail_count} fails)${latencySuffix}`;
        status.style.color = "var(--err)";
      } else if (m.fail_count > 0) {
        status.textContent = `${m.fail_count} recent fail${m.fail_count === 1 ? "" : "s"}${latencySuffix}`;
        status.style.color = "var(--warn)";
      } else {
        status.textContent = `Healthy${latencySuffix}`;
        status.style.color = "var(--ok)";
      }

      const sparkline = buildSparkline(m.latency_history);

      const resetBtn = document.createElement("button");
      resetBtn.className = "secondary";
      resetBtn.textContent = "Reset";
      resetBtn.addEventListener("click", () => {
        resetBtn.disabled = true;
        chrome.runtime.sendMessage({ action: "resetMirrorHealth", url: m.url }, (resp) => {
          if (!resp || !resp.success) {
            resetBtn.disabled = false;
            return;
          }
          loadMirrorHealth();
        });
      });

      if (sparkline) right.appendChild(sparkline);
      right.appendChild(status);
      right.appendChild(resetBtn);
      row.appendChild(label);
      row.appendChild(right);
      container.appendChild(row);
    });
  });
}

document.getElementById("btn-refresh-mirrors").addEventListener("click", loadMirrorHealth);

document.getElementById("btn-reset-all-mirrors").addEventListener("click", () => {
  const btn = document.getElementById("btn-reset-all-mirrors");
  btn.disabled = true;
  chrome.runtime.sendMessage({ action: "resetMirrorHealth" }, (resp) => {
    btn.disabled = false;
    if (!resp || !resp.success) return;
    loadMirrorHealth();
  });
});

function loadWatchlist() {
  const container = document.getElementById("watchlist-list");
  container.innerHTML = skeletonRowsHtml(2, "50%", "12%");

  chrome.runtime.sendMessage({ action: "getWatchlist" }, (watchlist) => {
    if (!Array.isArray(watchlist) || watchlist.length === 0) {
      container.innerHTML = '<div class="hint">No journals watched yet.</div>';
      return;
    }

    container.innerHTML = "";
    watchlist.forEach((w) => {
      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = w.journal || w.issn;

      const right = document.createElement("span");
      right.style.display = "flex";
      right.style.alignItems = "center";

      const value = document.createElement("span");
      value.className = "row-value";
      value.textContent = w.volume && w.issue ? `Vol. ${w.volume}, Issue ${w.issue}` : "No baseline yet";

      const removeBtn = document.createElement("button");
      removeBtn.className = "row-remove";
      removeBtn.title = "Stop watching";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "removeWatch", issn: w.issn }, loadWatchlist);
      });

      right.appendChild(value);
      right.appendChild(removeBtn);
      row.appendChild(label);
      row.appendChild(right);
      container.appendChild(row);
    });
  });
}

document.getElementById("btn-check-watchlist").addEventListener("click", () => {
  const btn = document.getElementById("btn-check-watchlist");
  btn.disabled = true;
  btn.textContent = "Checking…";
  chrome.runtime.sendMessage({ action: "checkWatchlistNow" }, () => {
    btn.disabled = false;
    btn.textContent = "Check Now";
    loadWatchlist();
  });
});

function loadAuthorWatchlist() {
  const container = document.getElementById("author-watchlist-list");
  container.innerHTML = skeletonRowsHtml(2, "50%", "12%");

  chrome.runtime.sendMessage({ action: "getAuthorWatchlist" }, (authorWatchlist) => {
    if (!Array.isArray(authorWatchlist) || authorWatchlist.length === 0) {
      container.innerHTML = '<div class="hint">No authors watched yet.</div>';
      return;
    }

    container.innerHTML = "";
    authorWatchlist.forEach((w) => {
      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = w.author;

      const right = document.createElement("span");
      right.style.display = "flex";
      right.style.alignItems = "center";

      const value = document.createElement("span");
      value.className = "row-value";
      value.textContent = w.title || "No baseline yet";

      const removeBtn = document.createElement("button");
      removeBtn.className = "row-remove";
      removeBtn.title = "Stop watching";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "removeAuthorWatch", author: w.author }, loadAuthorWatchlist);
      });

      right.appendChild(value);
      right.appendChild(removeBtn);
      row.appendChild(label);
      row.appendChild(right);
      container.appendChild(row);
    });
  });
}

document.getElementById("btn-check-author-watchlist").addEventListener("click", () => {
  const btn = document.getElementById("btn-check-author-watchlist");
  btn.disabled = true;
  btn.textContent = "Checking…";
  chrome.runtime.sendMessage({ action: "checkAuthorWatchlistNow" }, () => {
    btn.disabled = false;
    btn.textContent = "Check Now";
    loadAuthorWatchlist();
  });
});

const STAT_LABELS = {
  total: "Total downloads ever",
  last_7_weeks: "Last 7 weeks",
  last_7_months: "Last 7 months",
  last_year: "Last year",
};

function loadDownloadStats() {
  const container = document.getElementById("download-stats-list");
  container.innerHTML = skeletonRowsHtml(4, "55%", "15%");

  chrome.runtime.sendMessage({ action: "getDownloadStats" }, (resp) => {
    if (!resp || !resp.success) {
      container.innerHTML = `<div class="hint">Couldn't load download stats: ${escapeHtml(resp?.error || "Unknown error")}</div>`;
      return;
    }

    const counts = resp.counts || {};
    container.innerHTML = "";
    ["total", "last_7_weeks", "last_7_months", "last_year"].forEach((key) => {
      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = STAT_LABELS[key];

      const value = document.createElement("span");
      value.className = "row-value";
      value.textContent = counts[key] ?? 0;

      row.appendChild(label);
      row.appendChild(value);
      container.appendChild(row);
    });
  });
}

function loadPaperOfTheDay(refresh) {
  const container = document.getElementById("paper-of-the-day");
  if (!refresh) {
    container.innerHTML = `
      <div class="skeleton-bar" style="width: 90%; height: 13.5px; margin-bottom: 8px;"></div>
      <div class="skeleton-bar" style="width: 45%; height: 11.5px; margin-bottom: 14px;"></div>
      <div class="skeleton-bar" style="width: 30%; height: 32px; border-radius: 8px;"></div>
    `;
  }

  chrome.runtime.sendMessage({ action: "getPaperOfTheDay", refresh: !!refresh }, (resp) => {
    if (!resp || !resp.success) {
      container.innerHTML = `<div class="hint">${escapeHtml(resp?.error || "Couldn't pick a paper of the day.")} Download a few papers first.</div>`;
      return;
    }

    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "potd-title";
    title.textContent = resp.title;

    const meta = document.createElement("div");
    meta.className = "potd-meta";
    meta.textContent = resp.doi;

    container.appendChild(title);
    container.appendChild(meta);

    if (resp.abstract) {
      const abstractEl = document.createElement("div");
      abstractEl.className = "potd-abstract";
      abstractEl.textContent = resp.abstract;
      container.appendChild(abstractEl);
    }

    const actions = document.createElement("div");
    actions.className = "potd-actions";

    const btn = document.createElement("button");
    btn.textContent = "View on Sci-Hub";
    btn.addEventListener("click", () => {
      chrome.tabs.create({ url: resp.url });
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "secondary";
    refreshBtn.textContent = "Show Another";
    refreshBtn.addEventListener("click", () => {
      refreshBtn.disabled = true;
      loadPaperOfTheDay(true);
    });

    actions.appendChild(btn);
    actions.appendChild(refreshBtn);
    container.appendChild(actions);

    loadPaperOfTheDayHistory();
  });
}

function loadPaperOfTheDayHistory() {
  const wrap = document.getElementById("potd-history-wrap");
  const list = document.getElementById("potd-history-list");

  chrome.runtime.sendMessage({ action: "getPaperOfTheDayHistory" }, (resp) => {
    if (!resp || !resp.success || !resp.history || resp.history.length === 0) {
      wrap.style.display = "none";
      return;
    }

    wrap.style.display = "block";
    list.innerHTML = "";
    resp.history.forEach((entry) => {
      const row = document.createElement("a");
      row.className = "potd-history-row";
      row.href = entry.url;
      row.target = "_blank";
      row.title = entry.doi;

      const date = document.createElement("span");
      date.className = "potd-history-date";
      date.textContent = entry.date;

      const title = document.createElement("span");
      title.className = "potd-history-title";
      title.textContent = entry.title;

      row.appendChild(date);
      row.appendChild(title);
      list.appendChild(row);
    });
  });
}

load();
loadShortcuts();
loadPopupShortcuts();
loadMirrorHealth();
loadDownloadStats();
loadPaperOfTheDay();
loadWatchlist();
loadAuthorWatchlist();

document.getElementById("theme-select").addEventListener("change", (e) => {
  window.setTheme(e.target.value);
});

const btnExportBackup = document.getElementById("btn-export-backup");
const exportStatusEl = document.getElementById("export-status");
let exportStatusClearTimer = null;

btnExportBackup.addEventListener("click", async () => {
  clearTimeout(exportStatusClearTimer); // don't let an earlier run's clear-timer stomp this run's message
  btnExportBackup.disabled = true;
  exportStatusEl.className = "";
  exportStatusEl.textContent = "Bundling…";

  try {
    const syncSettings = await new Promise((resolve) => chrome.storage.sync.get(null, resolve));
    const localData = await new Promise((resolve) =>
      chrome.storage.local.get(["potdNonce", "potdHistory"], resolve)
    );
    const backupResp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ action: "exportBackupData" }, resolve)
    );

    if (!backupResp || !backupResp.success) {
      throw new Error((backupResp && backupResp.error) || "Couldn't reach the native host for logs/mirror health");
    }

    const files = [
      { name: "settings.json", content: JSON.stringify(syncSettings, null, 2) },
      { name: "local_storage.json", content: JSON.stringify(localData, null, 2) },
      { name: "download_log.txt", content: backupResp.downloadLog || "" },
      { name: "mirror_health.json", content: backupResp.mirrorHealth || "{}" },
    ];

    const zipBytes = ZipWriter.build(files);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);

    const a = document.createElement("a");
    a.href = url;
    a.download = `doi-grabber-backup-${today}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    exportStatusEl.className = "ok";
    exportStatusEl.textContent = "Downloaded ✓";
    exportStatusClearTimer = setTimeout(() => {
      exportStatusEl.textContent = "";
      exportStatusEl.className = "";
    }, 4000);
  } catch (err) {
    exportStatusEl.className = "error";
    exportStatusEl.textContent = "Export failed: " + err.message;
  } finally {
    btnExportBackup.disabled = false;
  }
});

document.getElementById("btn-report-bug").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("report.html") });
});

// Updates card — "Check for Updates" runs a fresh git-fetch-based check
// (doesn't just trust the 12-hour background cache, since the user clicked
// specifically to get a current answer); "Update Now" runs a fast-forward
// git pull through the native host and only appears once a check finds
// something behind origin.
const updateStatusEl = document.getElementById("update-status");
const updateChangelogWrapEl = document.getElementById("update-changelog-wrap");
const updateChangelogEl = document.getElementById("update-changelog");
const btnCheckUpdate = document.getElementById("btn-check-update");
const btnApplyUpdate = document.getElementById("btn-apply-update");
const updateActionStatusEl = document.getElementById("update-action-status");

function renderUpdateStatus(resp) {
  if (!resp || !resp.success) {
    updateStatusEl.innerHTML = `<div class="hint">Couldn't check for updates: ${
      escapeHtml((resp && resp.error) || "native host unreachable")
    }</div>`;
    updateChangelogWrapEl.style.display = "none";
    btnApplyUpdate.style.display = "none";
    return;
  }

  if (resp.behindBy > 0) {
    updateStatusEl.innerHTML = `<div class="hint">${resp.behindBy} update${
      resp.behindBy === 1 ? "" : "s"
    } available (currently at <code>${resp.localSha}</code>).</div>`;
    updateChangelogEl.innerHTML = resp.commits.map((c) => `<div class="row">${escapeHtml(c)}</div>`).join("");
    updateChangelogWrapEl.style.display = "";
    btnApplyUpdate.style.display = "";
  } else {
    updateStatusEl.innerHTML = `<div class="hint">Up to date (<code>${resp.localSha}</code>).</div>`;
    updateChangelogWrapEl.style.display = "none";
    btnApplyUpdate.style.display = "none";
  }

  chrome.storage.local.set({
    updateInfo: {
      behindBy: resp.behindBy,
      commits: resp.commits,
      localSha: resp.localSha,
      checkedAt: Date.now(),
    },
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function checkForUpdate() {
  btnCheckUpdate.disabled = true;
  updateStatusEl.innerHTML = skeletonRowsHtml(1, "60%", "0%");
  chrome.runtime.sendMessage({ action: "checkForUpdate" }, (resp) => {
    btnCheckUpdate.disabled = false;
    renderUpdateStatus(resp);
  });
}

btnCheckUpdate.addEventListener("click", checkForUpdate);

btnApplyUpdate.addEventListener("click", () => {
  btnApplyUpdate.disabled = true;
  btnCheckUpdate.disabled = true;
  updateActionStatusEl.className = "";
  updateActionStatusEl.textContent = "Updating…";

  chrome.runtime.sendMessage({ action: "applyUpdate" }, (resp) => {
    btnCheckUpdate.disabled = false;

    if (!resp || !resp.success) {
      updateActionStatusEl.className = "error";
      updateActionStatusEl.textContent = "Update failed: " + ((resp && resp.error) || "unknown error");
      btnApplyUpdate.disabled = false;
      return;
    }

    updateActionStatusEl.className = "ok";
    updateActionStatusEl.textContent = resp.nativeHostChanged
      ? "Updated ✓ — fully restart Chrome (not just reload the extension) to pick up native-host changes."
      : "Updated ✓ — reload the extension to pick up the changes.";
    btnApplyUpdate.style.display = "none";

    // Delay so the status message (and the restart-Chrome note, when it
    // applies) is actually readable before the extension reload blanks the page.
    setTimeout(() => chrome.runtime.reload(), 2500);
  });
});

if (location.hash === "#updates") {
  document.getElementById("updates").scrollIntoView();
}

checkForUpdate();
