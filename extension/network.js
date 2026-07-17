document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  window.toggleTheme();
});

const seedRowsEl = document.getElementById("seed-rows");
const btnAddSeedField = document.getElementById("btn-add-seed-field");
const btnBuild = document.getElementById("btn-build");
const statusLineEl = document.getElementById("status-line");
const seedCardEl = document.getElementById("seed-card");
const graphCardEl = document.getElementById("graph-card");
const graphWrapEl = document.getElementById("graph-wrap");
const graphTitleEl = document.getElementById("graph-title");
const graphStatusLineEl = document.getElementById("graph-status-line");
const addSeedInput = document.getElementById("add-seed-input");
const btnAddSeedLive = document.getElementById("btn-add-seed-live");
const btnReset = document.getElementById("btn-reset");
const zoomToolbarEl = document.getElementById("zoom-toolbar");
const zoomLevelEl = document.getElementById("zoom-level");
const btnZoomIn = document.getElementById("btn-zoom-in");
const btnZoomOut = document.getElementById("btn-zoom-out");
const btnZoomFit = document.getElementById("btn-zoom-fit");
const btnZoomReset = document.getElementById("btn-zoom-reset");
const navToolbarEl = document.getElementById("nav-toolbar");
const searchInput = document.getElementById("search-input");
const btnSearch = document.getElementById("btn-search");
const searchStatusEl = document.getElementById("search-status");
const searchResultsEl = document.getElementById("search-results");
const pathFromSelect = document.getElementById("path-from");
const pathToSelect = document.getElementById("path-to");
const btnFindPath = document.getElementById("btn-find-path");
const btnClearPath = document.getElementById("btn-clear-path");
const pathReadoutEl = document.getElementById("path-readout");
const focusTargetSelect = document.getElementById("focus-target");
const focusHopsInput = document.getElementById("focus-hops");
const btnEnableFocus = document.getElementById("btn-enable-focus");
const btnClearFocus = document.getElementById("btn-clear-focus");
const focusReadoutEl = document.getElementById("focus-readout");
const jointWorksPanelEl = document.getElementById("joint-works-panel");
const jointWorksTitleEl = document.getElementById("joint-works-title");
const jointWorksHintEl = document.getElementById("joint-works-hint");
const jointWorksListEl = document.getElementById("joint-works-list");
const jointWorksStatusEl = document.getElementById("joint-works-status");
const btnDownloadAllJoint = document.getElementById("btn-download-all-joint");
const btnCloseJointWorks = document.getElementById("btn-close-joint-works");

const STORAGE_KEY = "networkMap";
const EXPAND_MAX_NEW = 15; // caps how many new collaborators one expansion adds, so the graph stays legible
const RING_SPACING = 180;
const RING_BASE = 70; // radius of the hop-0 (seed) ring when there's more than one seed
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;
const METRIC_CONCURRENCY = 3; // throttled fetch of OpenAlex author metrics, same pattern as the Crossref reference-title backfill

// nodes: key ("family|given") -> { key, name, hop, isSeed, expanded, loading,
//   totalCount, citedByCount, worksCount, metricStatus }
// - totalCount is a *within-graph* connectivity signal only (sum of edge
//   weights touching this node in the currently-built graph) — it grows as
//   you expand more of the map and says nothing about the person's real
//   prominence, so it's shown in the tooltip but never drives size or
//   ring-order.
// - citedByCount/worksCount come from OpenAlex (getAuthorMetrics,
//   background.js), an absolute figure independent of how much of the graph
//   has been explored so far — these drive node radius and within-ring sort
//   order, so a major author renders big immediately even before anyone's
//   clicked to expand them.
// - metricStatus: "pending" | "loaded" | "notfound" | "error" — undefined
//   until the node is first created and queued.
// edges: "keyA~keyB" (sorted) -> count
let nodes = new Map();
let edges = new Map();
let zoomLevel = 1;
let graphBaseSize = 0; // unscaled SVG viewBox size, set each render — zoom scales width/height from this
const metricQueue = [];
let metricWorkersRunning = 0;

// Navigation state — path/focus are re-applied every renderGraph() call
// (as classes on the freshly-built nodes/edges) rather than mutating the
// underlying node/edge data, so clearing either is just "set to null and
// re-render," no separate cleanup pass needed.
let highlightPath = null; // ordered array of node keys, or null
let focusState = null; // { centerKey, hops, distances: Map<key, hopCount> } or null
let lastPositions = new Map(); // key -> {x, y}, from the most recent renderGraph — lets search/focus centering avoid redoing the whole layout
let lastCenter = 0;

function nodeKeyFor(fullName) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  const family = (parts.length > 1 ? parts[parts.length - 1] : parts[0] || "").toLowerCase();
  const given = parts.slice(0, -1).join(" ").toLowerCase();
  return family + "|" + given;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// --- Graph traversal (path / focus) --------------------------------------

// Edges are unweighted for this purpose — "shortest path" means fewest
// hops, not strongest collaboration, matching what a hop-distance readout
// actually promises.
function buildAdjacency() {
  const adjacency = new Map();
  edges.forEach((count, pairKey) => {
    const [a, b] = pairKey.split("~");
    if (!nodes.has(a) || !nodes.has(b)) return;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  });
  return adjacency;
}

function bfsDistances(startKey) {
  const adjacency = buildAdjacency();
  const dist = new Map([[startKey, 0]]);
  const queue = [startKey];
  while (queue.length > 0) {
    const cur = queue.shift();
    const d = dist.get(cur);
    (adjacency.get(cur) || []).forEach((next) => {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    });
  }
  return dist;
}

// Plain BFS shortest path — returns the ordered array of node keys from
// startKey to endKey (inclusive), or null if they're not connected in the
// currently-built graph (e.g. two separate, never-linked branches).
function findPath(startKey, endKey) {
  if (startKey === endKey) return [startKey];
  const adjacency = buildAdjacency();
  const parent = new Map([[startKey, null]]);
  const queue = [startKey];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === endKey) break;
    (adjacency.get(cur) || []).forEach((next) => {
      if (!parent.has(next)) {
        parent.set(next, cur);
        queue.push(next);
      }
    });
  }
  if (!parent.has(endKey)) return null;
  const path = [];
  let cur = endKey;
  while (cur !== null) {
    path.unshift(cur);
    cur = parent.get(cur);
  }
  return path;
}

// Single point of node creation, so every node — seed or discovered
// collaborator — always gets its metric fetch queued the same way. Returns
// the new node object.
function createNode(key, name, hop, isSeed) {
  const node = { key, name, hop, isSeed, expanded: false, loading: false, totalCount: 0, citedByCount: 0, worksCount: 0, metricStatus: undefined };
  nodes.set(key, node);
  queueMetricFetch(node);
  return node;
}

function fetchAuthorMetrics(authorName) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getAuthorMetrics", author: authorName }, (resp) => resolve(resp));
  });
}

// Only ever queues a node once — metricStatus doubles as both the display
// state and the "already queued/fetched" guard, so a node re-discovered via
// a second expansion doesn't trigger a duplicate lookup.
function queueMetricFetch(node) {
  if (node.metricStatus) return;
  node.metricStatus = "pending";
  metricQueue.push(node.key);
  pumpMetricQueue();
}

function pumpMetricQueue() {
  while (metricWorkersRunning < METRIC_CONCURRENCY && metricQueue.length > 0) {
    const key = metricQueue.shift();
    const node = nodes.get(key);
    if (!node) continue; // node was removed by "Start New Map" while its fetch was queued

    metricWorkersRunning += 1;
    fetchAuthorMetrics(node.name).then((resp) => {
      metricWorkersRunning -= 1;
      const stillPresent = nodes.get(key);
      if (stillPresent) {
        if (resp && resp.success && resp.found) {
          stillPresent.citedByCount = resp.citedByCount;
          stillPresent.worksCount = resp.worksCount;
          stillPresent.metricStatus = "loaded";
        } else if (resp && resp.success) {
          stillPresent.metricStatus = "notfound";
        } else {
          stillPresent.metricStatus = "error";
        }
        saveState();
        renderGraph();
      }
      pumpMetricQueue();
    });
  }
}

// --- Seed input form -------------------------------------------------

function addSeedField(value) {
  const row = document.createElement("div");
  row.className = "seed-row";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Author name…";
  input.value = value || "";
  input.addEventListener("input", updateBuildEnabled);

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove this field";
  removeBtn.addEventListener("click", () => {
    row.remove();
    updateBuildEnabled();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  seedRowsEl.appendChild(row);
}

function currentSeedNames() {
  return Array.from(seedRowsEl.querySelectorAll("input"))
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function updateBuildEnabled() {
  btnBuild.disabled = currentSeedNames().length < 2;
}

btnAddSeedField.addEventListener("click", () => addSeedField());

// --- Fetching + merging ------------------------------------------------

function fetchCollaborators(authorName) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getCollaborators", author: authorName }, (resp) => resolve(resp));
  });
}

// Merges one author's collaborator results into the shared node/edge maps.
// `hop` is only used the first time a node is discovered — once a node
// exists, its ring position never moves, even if a later expansion would
// have reached it via a shorter path. Keeps the layout stable as you click
// around instead of nodes jumping rings mid-session.
function mergeCollaborators(sourceKey, sourceHop, collaborators, edgeList) {
  const top = collaborators.slice(0, EXPAND_MAX_NEW);
  const topKeys = new Set(top.map((c) => c.key));

  top.forEach((c) => {
    if (!nodes.has(c.key)) {
      createNode(c.key, c.name, sourceHop + 1, false);
    }
    const pairKey = [sourceKey, c.key].sort().join("~");
    edges.set(pairKey, Math.max(edges.get(pairKey) || 0, c.count));
  });

  // Edges between two collaborators that are both already in the graph
  // (co-authored with each other on a shared work) — keeps the map from
  // looking like a pure star/tree once enough nodes accumulate.
  edgeList.forEach((e) => {
    if (!topKeys.has(e.a) && e.a !== sourceKey) return;
    if (!topKeys.has(e.b) && e.b !== sourceKey) return;
    if (!nodes.has(e.a) || !nodes.has(e.b)) return;
    const pairKey = [e.a, e.b].sort().join("~");
    edges.set(pairKey, Math.max(edges.get(pairKey) || 0, e.count));
  });

  return top.length < collaborators.length;
}

// totalCount is connectivity within the current graph only — see the field
// notes above `nodes`/`edges`. Not used for node size or sort order.
function recomputeTotalCounts() {
  nodes.forEach((n) => { n.totalCount = 0; });
  edges.forEach((count, pairKey) => {
    const [a, b] = pairKey.split("~");
    if (nodes.has(a)) nodes.get(a).totalCount += count;
    if (nodes.has(b)) nodes.get(b).totalCount += count;
  });
}

function saveState() {
  chrome.storage.local.set({
    [STORAGE_KEY]: {
      nodes: Array.from(nodes.values()).map((n) => ({ ...n, loading: false })),
      edges: Array.from(edges.entries()),
    },
  });
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (v) => resolve(v[STORAGE_KEY] || null));
  });
}

// --- Rendering -----------------------------------------------------------

function renderGraph() {
  if (nodes.size === 0) {
    graphWrapEl.innerHTML = '<div id="empty-graph">Nothing to show yet.</div>';
    zoomToolbarEl.style.display = "none";
    navToolbarEl.style.display = "none";
    return;
  }
  zoomToolbarEl.style.display = "flex";
  navToolbarEl.style.display = "flex";

  recomputeTotalCounts();

  const byHop = new Map(); // hop -> [node, ...]
  nodes.forEach((n) => {
    if (!byHop.has(n.hop)) byHop.set(n.hop, []);
    byHop.get(n.hop).push(n);
  });
  const maxHop = Math.max(...byHop.keys());

  const size = 2 * (RING_BASE + (maxHop + 1) * RING_SPACING);
  const center = size / 2;

  const positions = new Map(); // key -> { x, y }
  byHop.forEach((list, hop) => {
    // Sorted by absolute OpenAlex prominence (falls back to within-graph
    // connectivity, then name, for nodes whose metric hasn't loaded yet or
    // tied at 0) rather than totalCount alone — keeps ordering stable
    // instead of reshuffling every time a sibling node gets expanded.
    list.sort((a, b) => (b.citedByCount - a.citedByCount) || (b.totalCount - a.totalCount) || a.name.localeCompare(b.name));
    const radius = list.length === 1 && hop === 0 ? 0 : RING_BASE + hop * RING_SPACING;
    list.forEach((n, i) => {
      const angle = (i / list.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(n.key, {
        x: center + radius * Math.cos(angle),
        y: center + radius * Math.sin(angle),
      });
    });
  });

  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, xmlns: "http://www.w3.org/2000/svg" });
  graphBaseSize = size;
  lastPositions = positions;
  lastCenter = center;

  // A path is a specific ordered sequence of nodes — only edges between
  // *consecutive* pair in that sequence count as "on the path" (an edge
  // that happens to connect two path nodes out of order doesn't).
  const pathEdgeKeys = new Set();
  if (highlightPath) {
    for (let i = 0; i < highlightPath.length - 1; i++) {
      pathEdgeKeys.add([highlightPath[i], highlightPath[i + 1]].sort().join("~"));
    }
  }

  const maxEdgeCount = Math.max(1, ...Array.from(edges.values()));
  edges.forEach((count, pairKey) => {
    const [a, b] = pairKey.split("~");
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) return;

    const onPath = pathEdgeKeys.has(pairKey);
    const faded = !onPath && focusState && (
      !focusState.distances.has(a) || !focusState.distances.has(b) ||
      focusState.distances.get(a) > focusState.hops || focusState.distances.get(b) > focusState.hops
    );

    const line = svgEl("line", {
      x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
      stroke: onPath ? "var(--accent)" : "var(--border)",
      "stroke-width": onPath ? 3.5 : 1 + (count / maxEdgeCount) * 2.5,
      opacity: faded ? 0.08 : onPath ? 1 : 0.55,
      class: "edge-line",
    });
    const lineTitle = svgEl("title", {});
    const nameA = nodes.get(a).name;
    const nameB = nodes.get(b).name;
    lineTitle.textContent = `${nameA} & ${nameB} — ${count} shared work${count === 1 ? "" : "s"} — click to view`;
    line.appendChild(lineTitle);
    line.addEventListener("click", () => openJointWorksPanel(a, b));
    svg.appendChild(line);
  });

  // Log-scaled off an absolute, graph-independent metric (OpenAlex
  // cited_by_count) rather than totalCount, so a prominent author renders
  // big right away instead of starting tiny just because only one of their
  // edges has been discovered so far — and so a node's size doesn't shift
  // every time you expand somewhere else in the graph. Citation counts span
  // several orders of magnitude, hence log rather than linear scaling.
  const maxMetric = Math.max(1, ...Array.from(nodes.values()).map((n) => n.citedByCount));
  nodes.forEach((n) => {
    const p = positions.get(n.key);
    if (!p) return;
    const metricScale = Math.log(1 + n.citedByCount) / Math.log(1 + maxMetric);
    const r = n.isSeed ? 11 + metricScale * 9 : 5 + metricScale * 11;

    const onPath = highlightPath && highlightPath.includes(n.key);
    const faded = !onPath && focusState && (!focusState.distances.has(n.key) || focusState.distances.get(n.key) > focusState.hops);

    const group = svgEl("g", {
      class: "net-node" + (n.isSeed ? " seed" : "") + (n.expanded ? " expanded" : "") + (n.loading ? " loading" : "") + (onPath ? " on-path" : "") + (faded ? " faded" : ""),
      "data-key": n.key,
    });

    const title = svgEl("title", {});
    const metricText = n.metricStatus === "loaded"
      ? `${n.citedByCount} citations, ${n.worksCount} works (OpenAlex)`
      : n.metricStatus === "pending" || n.metricStatus === undefined
        ? "prominence loading…"
        : "prominence unknown (not found on OpenAlex)";
    const connectivityText = `connected via ${n.totalCount} shared work${n.totalCount === 1 ? "" : "s"} in this map`;
    title.textContent = n.isSeed
      ? `${n.name} (seed) — ${metricText}`
      : `${n.name} — ${metricText} — ${connectivityText}${n.expanded ? " (expanded)" : " — click to expand"}`;
    group.appendChild(title);

    const dot = svgEl("circle", { cx: p.x, cy: p.y, r, class: "node-dot" });
    if (!n.loading) {
      dot.addEventListener("click", () => expandNode(n.key));
    }
    group.appendChild(dot);

    const labelY = p.y + (p.y >= center ? r + 12 : -r - 6);
    const label = svgEl("text", { x: p.x, y: labelY, "text-anchor": "middle", class: "net-node-label" });
    label.textContent = n.name.length > 22 ? n.name.slice(0, 20) + "…" : n.name;
    group.appendChild(label);

    // Small separate open-in-new-tab affordance, offset from the label so it
    // doesn't fight the expand click on the node itself.
    const linkY = labelY + (p.y >= center ? 11 : -11);
    const openLink = svgEl("a", { class: "node-open-link" });
    openLink.setAttribute("href", chrome.runtime.getURL("author.html") + "?author=" + encodeURIComponent(n.name));
    openLink.setAttribute("target", "_blank");
    const openText = svgEl("text", { x: p.x, y: linkY, "text-anchor": "middle" });
    openText.textContent = "↗ open works page";
    openLink.appendChild(openText);
    group.appendChild(openLink);

    svg.appendChild(group);
  });

  graphWrapEl.innerHTML = "";
  graphWrapEl.appendChild(svg);
  applyZoom(); // re-assert the current zoom level on the freshly-built SVG
  refreshNodeSelectors();

  graphTitleEl.textContent = `Network — ${nodes.size} people, ${edges.size} connections`;
}

// --- Zoom / pan ------------------------------------------------------------

function applyZoom() {
  const svg = graphWrapEl.querySelector("svg");
  if (!svg || !graphBaseSize) return;
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel));
  const scaled = graphBaseSize * zoomLevel;
  svg.setAttribute("width", scaled);
  svg.setAttribute("height", scaled);
  zoomLevelEl.textContent = Math.round(zoomLevel * 100) + "%";
}

// Zooms while keeping whatever point is under the cursor (or the container's
// center, for the +/- buttons) visually still, instead of always zooming
// toward the top-left corner the way a naive width/height change would.
function zoomBy(factor, anchorClientX, anchorClientY) {
  const rect = graphWrapEl.getBoundingClientRect();
  const cx = anchorClientX != null ? anchorClientX : rect.left + rect.width / 2;
  const cy = anchorClientY != null ? anchorClientY : rect.top + rect.height / 2;
  const offsetX = cx - rect.left + graphWrapEl.scrollLeft;
  const offsetY = cy - rect.top + graphWrapEl.scrollTop;

  const oldZoom = zoomLevel;
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel * factor));
  applyZoom();

  const scale = zoomLevel / oldZoom;
  graphWrapEl.scrollLeft = offsetX * scale - (cx - rect.left);
  graphWrapEl.scrollTop = offsetY * scale - (cy - rect.top);
}

btnZoomIn.addEventListener("click", () => zoomBy(1 + ZOOM_STEP));
btnZoomOut.addEventListener("click", () => zoomBy(1 / (1 + ZOOM_STEP)));

btnZoomReset.addEventListener("click", () => {
  zoomLevel = 1;
  applyZoom();
});

btnZoomFit.addEventListener("click", () => {
  const svg = graphWrapEl.querySelector("svg");
  if (!svg || !graphBaseSize) return;
  const padding = 24;
  const availableW = graphWrapEl.clientWidth - padding;
  const availableH = graphWrapEl.clientHeight - padding;
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(availableW, availableH) / graphBaseSize));
  applyZoom();
  graphWrapEl.scrollLeft = 0;
  graphWrapEl.scrollTop = 0;
});

// Trackpad pinch and Ctrl/Cmd+wheel both report as wheel events with
// ctrlKey/metaKey set (that's how Chrome signals a pinch gesture on a
// trackpad, not just an actual held-down Ctrl key) — plain wheel/scroll is
// left alone so normal two-finger scrolling still pans via the native
// overflow:auto scrollbars.
graphWrapEl.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  zoomBy(factor, e.clientX, e.clientY);
}, { passive: false });

// Click-and-drag panning, since a graph this size is awkward to navigate
// with scrollbars alone. Only starts when the mousedown lands on empty
// graph background (the SVG element itself) — starting a drag on a node
// would fight its click-to-expand handler, and starting one on the
// open-works-page link would fight that navigation.
let panState = null;

graphWrapEl.addEventListener("mousedown", (e) => {
  if (e.target.tagName !== "svg") return;
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    scrollLeft: graphWrapEl.scrollLeft,
    scrollTop: graphWrapEl.scrollTop,
  };
  graphWrapEl.classList.add("panning");
});

window.addEventListener("mousemove", (e) => {
  if (!panState) return;
  graphWrapEl.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
  graphWrapEl.scrollTop = panState.scrollTop - (e.clientY - panState.startY);
});

window.addEventListener("mouseup", () => {
  if (!panState) return;
  panState = null;
  graphWrapEl.classList.remove("panning");
});

// --- Navigation: search / path / focus -----------------------------------

// Rebuilds the path-from/path-to/focus-target <select> option lists from
// the current node set, run at the end of every renderGraph() so newly
// discovered people show up without a separate refresh step. Preserves the
// current selection where the selected node still exists.
function refreshNodeSelectors() {
  const sorted = Array.from(nodes.values()).sort((a, b) => a.name.localeCompare(b.name));
  [pathFromSelect, pathToSelect, focusTargetSelect].forEach((select) => {
    const previous = select.value;
    select.innerHTML = "";
    sorted.forEach((n) => {
      const option = document.createElement("option");
      option.value = n.key;
      option.textContent = n.name;
      select.appendChild(option);
    });
    if (sorted.some((n) => n.key === previous)) select.value = previous;
  });
}

// Scrolls the graph container so the given node is centered in view, at the
// current zoom level — used by both search and (implicitly, via its own
// select) anything else that wants to jump to a node.
function centerOnNode(key) {
  const pos = lastPositions.get(key);
  if (!pos) return;
  const scaledX = pos.x * zoomLevel;
  const scaledY = pos.y * zoomLevel;
  graphWrapEl.scrollLeft = scaledX - graphWrapEl.clientWidth / 2;
  graphWrapEl.scrollTop = scaledY - graphWrapEl.clientHeight / 2;
}

function pulseNode(key) {
  const group = graphWrapEl.querySelector(`.net-node[data-key="${CSS.escape(key)}"]`);
  if (!group) return;
  group.classList.add("search-hit");
  setTimeout(() => group.classList.remove("search-hit"), 2800);
}

function jumpToNode(key) {
  centerOnNode(key);
  pulseNode(key);
}

function runSearch() {
  const query = searchInput.value.trim().toLowerCase();
  searchResultsEl.innerHTML = "";
  if (!query) {
    searchStatusEl.className = "";
    searchStatusEl.textContent = "";
    return;
  }

  const matches = Array.from(nodes.values()).filter((n) => n.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    searchStatusEl.className = "error";
    searchStatusEl.textContent = "No one in this map matches that.";
  } else if (matches.length === 1) {
    searchStatusEl.className = "";
    searchStatusEl.textContent = `Found ${matches[0].name}.`;
    jumpToNode(matches[0].key);
  } else {
    searchStatusEl.className = "";
    searchStatusEl.textContent = `${matches.length} matches — pick one:`;
    matches.forEach((n) => {
      const btn = document.createElement("button");
      btn.textContent = n.name;
      btn.addEventListener("click", () => jumpToNode(n.key));
      searchResultsEl.appendChild(btn);
    });
  }
}

btnSearch.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

btnFindPath.addEventListener("click", () => {
  const fromKey = pathFromSelect.value;
  const toKey = pathToSelect.value;
  if (!fromKey || !toKey) return;

  if (fromKey === toKey) {
    highlightPath = null;
    pathReadoutEl.className = "";
    pathReadoutEl.textContent = "Pick two different people.";
    renderGraph();
    return;
  }

  const path = findPath(fromKey, toKey);
  if (!path) {
    highlightPath = null;
    pathReadoutEl.className = "error";
    const fromName = nodes.get(fromKey).name;
    const toName = nodes.get(toKey).name;
    pathReadoutEl.textContent = `No path found between ${fromName} and ${toName} in the current map — try expanding more nodes.`;
  } else {
    highlightPath = path;
    pathReadoutEl.className = "";
    const hops = path.length - 1;
    const names = path.map((k) => nodes.get(k).name).join(" → ");
    pathReadoutEl.textContent = `${hops} hop${hops === 1 ? "" : "s"}: ${names}`;
  }
  renderGraph();
});

btnClearPath.addEventListener("click", () => {
  highlightPath = null;
  pathReadoutEl.className = "";
  pathReadoutEl.textContent = "";
  renderGraph();
});

btnEnableFocus.addEventListener("click", () => {
  const centerKey = focusTargetSelect.value;
  if (!centerKey) return;
  const hops = Math.max(0, Math.min(6, Number(focusHopsInput.value) || 0));
  const distances = bfsDistances(centerKey);
  focusState = { centerKey, hops, distances };
  focusReadoutEl.className = "";
  const inRange = Array.from(distances.values()).filter((d) => d <= hops).length;
  focusReadoutEl.textContent = `Focused on ${nodes.get(centerKey).name} — showing ${inRange} of ${nodes.size} people within ${hops} hop${hops === 1 ? "" : "s"}.`;
  renderGraph();
});

btnClearFocus.addEventListener("click", () => {
  focusState = null;
  focusReadoutEl.className = "";
  focusReadoutEl.textContent = "";
  renderGraph();
});

// --- Expansion -----------------------------------------------------------

async function expandNode(key) {
  const node = nodes.get(key);
  if (!node || node.expanded || node.loading) return;

  node.loading = true;
  renderGraph();
  graphStatusLineEl.className = "";
  graphStatusLineEl.textContent = `Fetching ${node.name}'s collaborators…`;

  const resp = await fetchCollaborators(node.name);
  node.loading = false;

  if (!resp || !resp.success) {
    graphStatusLineEl.className = "error";
    graphStatusLineEl.textContent = `Couldn't fetch collaborators for ${node.name}: ${(resp && resp.error) || "unknown error"}`;
    renderGraph();
    return;
  }

  const collaborators = resp.collaborators || [];
  const truncated = mergeCollaborators(key, node.hop, collaborators, resp.edges || []);
  node.expanded = true;

  graphStatusLineEl.className = "";
  graphStatusLineEl.textContent = collaborators.length === 0
    ? `${node.name} has no co-authored works found on Crossref.`
    : `Added ${Math.min(collaborators.length, EXPAND_MAX_NEW)} of ${collaborators.length} collaborators for ${node.name}${truncated ? " (showing top " + EXPAND_MAX_NEW + " by shared works)" : ""}.`;

  saveState();
  renderGraph();
}

// --- Joint works (edge click) ---------------------------------------------

function sanitizeFolderName(name) {
  return name.replace(/[^\w\-. ]/g, "").trim().replace(/\s+/g, " ") || "network";
}

function getSyncSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["outputDir"], resolve);
  });
}

function getDefaultOutputDir() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDefaultOutputDir" }, (resp) => {
      resolve(resp && resp.success && resp.path ? resp.path : "");
    });
  });
}

let jointOutputDir = null;
let jointLogPath = null;

async function resolveJointOutputPaths(nameA, nameB) {
  const settings = await getSyncSettings();
  let baseDir = (settings.outputDir || "").replace(/\/+$/, "");
  if (!baseDir) baseDir = (await getDefaultOutputDir()).replace(/\/+$/, "");
  const folderName = sanitizeFolderName(`Network Map - ${nameA} & ${nameB}`);
  jointOutputDir = `${baseDir}/${folderName}`;
  jointLogPath = `${jointOutputDir}/download_log.txt`;
}

function jointLogLine(line) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  chrome.runtime.sendMessage({ action: "appendLog", filepath: jointLogPath, line: `${timestamp} | ${line}` });
}

let jointWorksCurrent = []; // the currently-displayed panel's work list, for "Download All"

function renderJointWorksList(works) {
  jointWorksListEl.innerHTML = "";
  works.forEach((work, i) => {
    const row = document.createElement("div");
    row.className = "joint-work-row";

    const info = document.createElement("div");
    info.className = "joint-work-info";
    const title = document.createElement("div");
    title.className = "joint-work-title";
    title.textContent = work.title;
    const meta = document.createElement("div");
    meta.className = "joint-work-meta";
    meta.textContent = [work.year, work.doi || "no DOI found"].filter(Boolean).join(" · ");
    info.appendChild(title);
    info.appendChild(meta);

    const status = document.createElement("div");
    status.className = "joint-work-status";
    status.id = "joint-status-" + i;
    status.textContent = work.doi ? "Pending" : "No DOI";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "btn-secondary";
    downloadBtn.textContent = "Download";
    downloadBtn.disabled = !work.doi;
    downloadBtn.addEventListener("click", () => downloadJointWork(work, status, downloadBtn));

    row.appendChild(info);
    row.appendChild(status);
    row.appendChild(downloadBtn);
    jointWorksListEl.appendChild(row);
  });
}

function downloadJointWork(work, statusEl, buttonEl) {
  buttonEl.disabled = true;
  statusEl.textContent = "Downloading…";
  statusEl.className = "joint-work-status";

  chrome.runtime.sendMessage({ action: "sendDOI", doi: work.doi, outputDirOverride: jointOutputDir }, (resp) => {
    const result = resp && resp.result;
    if (resp && resp.success && result && result.status === "ok") {
      const isOa = result.source === "open_access";
      statusEl.textContent = isOa ? "Downloaded ✓ (open access)" : "Downloaded ✓";
      statusEl.className = "joint-work-status ok";
      jointLogLine(`SUCCESS | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
    } else if (resp && resp.success && result && result.status === "corrupt") {
      statusEl.textContent = "Corrupt file";
      statusEl.className = "joint-work-status err";
      buttonEl.disabled = false;
      jointLogLine(`CORRUPT | ${work.doi} | ${work.title} | ${result.filepath || ""}`);
    } else {
      statusEl.textContent = "Not found";
      statusEl.className = "joint-work-status err";
      buttonEl.disabled = false;
      const detail = (result && result.detail) || (resp && resp.error) || "unknown error";
      jointLogLine(`FAILED | ${work.doi} | ${work.title} | ${detail}`);
    }
  });
}

async function openJointWorksPanel(keyA, keyB) {
  const nodeA = nodes.get(keyA);
  const nodeB = nodes.get(keyB);
  if (!nodeA || !nodeB) return;

  jointWorksPanelEl.style.display = "block";
  jointWorksPanelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  jointWorksTitleEl.textContent = `Joint Works — ${nodeA.name} & ${nodeB.name}`;
  jointWorksHintEl.textContent = "Loading shared papers from Crossref…";
  jointWorksListEl.innerHTML = "";
  jointWorksStatusEl.textContent = "";
  jointWorksStatusEl.className = "";
  jointWorksCurrent = [];

  await resolveJointOutputPaths(nodeA.name, nodeB.name);

  chrome.runtime.sendMessage({ action: "getJointWorks", authorA: nodeA.name, authorB: nodeB.name }, (resp) => {
    if (!resp || !resp.success) {
      jointWorksHintEl.textContent = "Couldn't load shared papers: " + ((resp && resp.error) || "unknown error");
      return;
    }
    const works = resp.works || [];
    jointWorksCurrent = works;
    jointWorksHintEl.textContent = works.length === 0
      ? "No shared works found on Crossref for this pair."
      : `${works.length} shared paper${works.length === 1 ? "" : "s"} found, saved to a "Network Map - ${nodeA.name} & ${nodeB.name}" subfolder.`;
    renderJointWorksList(works);
  });
}

btnDownloadAllJoint.addEventListener("click", () => {
  const rows = Array.from(jointWorksListEl.querySelectorAll(".joint-work-row"));
  jointWorksCurrent.forEach((work, i) => {
    if (!work.doi) return;
    const row = rows[i];
    const statusEl = row.querySelector(".joint-work-status");
    const buttonEl = row.querySelector("button");
    if (statusEl.textContent === "Downloaded ✓" || statusEl.textContent === "Downloaded ✓ (open access)") return;
    downloadJointWork(work, statusEl, buttonEl);
  });
});

btnCloseJointWorks.addEventListener("click", () => {
  jointWorksPanelEl.style.display = "none";
});

// --- Build / add seed / reset --------------------------------------------

async function buildFromSeeds(seedNames) {
  seedCardEl.style.display = "none";
  graphCardEl.style.display = "block";
  graphStatusLineEl.textContent = "Fetching seed authors' collaborators…";

  for (const name of seedNames) {
    const key = nodeKeyFor(name);
    if (!nodes.has(key)) {
      createNode(key, name, 0, true);
    } else {
      nodes.get(key).isSeed = true;
    }
  }

  for (const name of seedNames) {
    const key = nodeKeyFor(name);
    const node = nodes.get(key);
    if (node.expanded) continue;
    node.loading = true;
    renderGraph();
    const resp = await fetchCollaborators(name);
    node.loading = false;
    if (resp && resp.success) {
      mergeCollaborators(key, 0, resp.collaborators || [], resp.edges || []);
      node.expanded = true;
    }
  }

  graphStatusLineEl.className = "";
  graphStatusLineEl.textContent = `Built network from ${seedNames.length} seed author${seedNames.length === 1 ? "" : "s"}.`;
  saveState();
  renderGraph();
}

btnBuild.addEventListener("click", () => {
  const seedNames = currentSeedNames();
  if (seedNames.length < 2) return;
  buildFromSeeds(seedNames);
});

btnAddSeedLive.addEventListener("click", () => {
  const name = addSeedInput.value.trim();
  if (!name) return;
  addSeedInput.value = "";
  buildFromSeeds([name]);
});

addSeedInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnAddSeedLive.click();
});

btnReset.addEventListener("click", () => {
  if (!confirm("Clear the current map and start over?")) return;
  nodes = new Map();
  edges = new Map();
  highlightPath = null;
  focusState = null;
  chrome.storage.local.remove([STORAGE_KEY]);
  graphCardEl.style.display = "none";
  seedCardEl.style.display = "block";
  seedRowsEl.innerHTML = "";
  addSeedField();
  addSeedField();
  updateBuildEnabled();
  statusLineEl.textContent = "";
  pathReadoutEl.textContent = "";
  focusReadoutEl.textContent = "";
  searchStatusEl.textContent = "";
  searchResultsEl.innerHTML = "";
  jointWorksPanelEl.style.display = "none";
});

// --- Init ------------------------------------------------------------------

(async function init() {
  const saved = await loadState();
  if (saved && saved.nodes && saved.nodes.length > 0) {
    nodes = new Map(saved.nodes.map((n) => [n.key, {
      totalCount: 0, citedByCount: 0, worksCount: 0, metricStatus: undefined, // defaults for state saved before this field existed
      ...n,
      loading: false,
    }]));
    edges = new Map(saved.edges || []);
    seedCardEl.style.display = "none";
    graphCardEl.style.display = "block";
    graphStatusLineEl.textContent = `Resumed map — ${nodes.size} people, ${edges.size} connections.`;

    // Re-queue only metric fetches that never finished last time ("pending"
    // means the tab was closed mid-request; "error" is worth one retry on a
    // fresh page load). Nodes already "loaded" or "notfound" keep their
    // cached result rather than re-hitting OpenAlex on every reopen.
    nodes.forEach((n) => {
      if (n.metricStatus === "pending" || n.metricStatus === "error" || n.metricStatus === undefined) {
        n.metricStatus = undefined;
        queueMetricFetch(n);
      }
    });

    renderGraph();
  } else {
    addSeedField();
    addSeedField();
    updateBuildEnabled();
  }
})();
