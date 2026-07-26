(function () {
  const $ = (id) => document.getElementById(id);
  const runDesc = $("run-desc");
  const statusText = $("status-text");
  const statusSub = $("status-sub");
  const resultsEl = $("results");

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const DIR_LABELS = { both: "Both", backward: "Backward (references)", forward: "Forward (citations)" };

  function setStatus(text, isErr) {
    statusText.textContent = text;
    statusText.className = isErr ? "err" : "";
  }
  function setSub(text) {
    statusSub.textContent = text;
  }

  let currentDoi = "";
  let lastEdges = [];
  let lastSeedTitle = "";
  let lastSeedAuthor = "";

  chrome.storage.local.get("snowballRunParams", (res) => {
    const p = res && res.snowballRunParams;
    if (!p || !p.doi) {
      runDesc.textContent = "No run parameters found.";
      setStatus('Start a snowball from Settings → Citation Snowballing, then click "Run snowball".', true);
      return;
    }

    currentDoi = p.doi;
    const dirLabel = DIR_LABELS[p.dir] || "Both";
    runDesc.textContent = `Seed ${p.doi} · ${dirLabel} · ${p.depth} hop${p.depth === 1 ? "" : "s"} · cap ${p.cap} · max ${p.max}`;
    runSnowball(p);
  });

  function runSnowball(p) {
    setStatus("Starting…");
    const port = chrome.runtime.connect({ name: "snowball" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        setStatus("Expanding hop " + msg.depth + " · " + msg.found + " papers found (checked " + msg.processed + ")");
      } else if (msg.type === "done") {
        lastEdges = msg.edges || [];
        lastSeedTitle = msg.seedTitle || "";
        lastSeedAuthor = msg.seedAuthor || "";
        renderResults(msg.results, msg.stats);
        port.disconnect();
      } else if (msg.type === "error") {
        setStatus(msg.message, true);
        port.disconnect();
      }
    });
    port.postMessage({ cmd: "run", doi: p.doi, dir: p.dir, depth: p.depth, cap: p.cap, max: p.max });
  }

  function renderResults(results, stats) {
    const dois = results.map((r) => r.doi);
    setStatus(
      stats.unique + " unique papers · " + stats.merges + " duplicates merged" +
      (stats.capped ? " · hit the max-papers limit" : "")
    );
    setSub("");
    resultsEl.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "actions";

    const dl = document.createElement("button");
    dl.textContent = "Download all (" + dois.length + ")";
    dl.addEventListener("click", () => startDownload(dois));

    const cp = document.createElement("button");
    cp.textContent = "Copy DOIs";
    cp.addEventListener("click", () => {
      navigator.clipboard.writeText(dois.join("\n")).then(() => setSub("Copied " + dois.length + " DOIs to the clipboard."));
    });

    const gv = document.createElement("button");
    gv.textContent = "View as graph";
    gv.addEventListener("click", () => {
      chrome.storage.local.set({
        snowballGraph: {
          seed: { doi: currentDoi, title: lastSeedTitle, author: lastSeedAuthor },
          nodes: results,
          edges: lastEdges,
        },
      }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("graph.html") });
      });
    });

    bar.appendChild(dl);
    bar.appendChild(cp);
    bar.appendChild(gv);
    resultsEl.appendChild(bar);

    const list = document.createElement("div");
    list.className = "list";
    results.forEach((r) => {
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("div");
      left.className = "row-title";
      left.innerHTML = '<span class="row-tag">[' + r.via + " · hop " + r.depth + "]</span> " + (r.title ? esc(r.title) : r.doi);
      const a = document.createElement("a");
      a.href = "https://doi.org/" + r.doi;
      a.textContent = r.doi;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "row-link";
      row.appendChild(left);
      row.appendChild(a);
      list.appendChild(row);
    });
    resultsEl.appendChild(list);
  }

  function startDownload(dois) {
    if (!dois.length) return;
    setSub("Starting download of " + dois.length + " papers…");
    const port = chrome.runtime.connect({ name: "snowball" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "dlprogress") {
        setSub("Downloading " + msg.done + "/" + msg.total + (msg.failed ? " · " + msg.failed + " failed" : ""));
      } else if (msg.type === "dldone") {
        setSub("Done — downloaded " + msg.done + "/" + msg.total + (msg.failed ? " · " + msg.failed + " failed" : ""));
        port.disconnect();
      }
    });
    port.postMessage({ cmd: "download", dois });
  }
})();
