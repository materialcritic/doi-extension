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

const STORAGE_KEY = "networkMap";
const EXPAND_MAX_NEW = 15; // caps how many new collaborators one expansion adds, so the graph stays legible
const RING_SPACING = 180;
const RING_BASE = 70; // radius of the hop-0 (seed) ring when there's more than one seed
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;

// nodes: key ("family|given") -> { key, name, hop, isSeed, expanded, loading, totalCount }
// edges: "keyA~keyB" (sorted) -> count
let nodes = new Map();
let edges = new Map();
let zoomLevel = 1;
let graphBaseSize = 0; // unscaled SVG viewBox size, set each render — zoom scales width/height from this

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
      nodes.set(c.key, { key: c.key, name: c.name, hop: sourceHop + 1, isSeed: false, expanded: false, loading: false, totalCount: 0 });
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
    return;
  }
  zoomToolbarEl.style.display = "flex";

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
    list.sort((a, b) => b.totalCount - a.totalCount);
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

  const maxEdgeCount = Math.max(1, ...Array.from(edges.values()));
  edges.forEach((count, pairKey) => {
    const [a, b] = pairKey.split("~");
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) return;
    svg.appendChild(svgEl("line", {
      x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
      stroke: "var(--border)",
      "stroke-width": 1 + (count / maxEdgeCount) * 2.5,
      opacity: 0.55,
    }));
  });

  const maxTotal = Math.max(1, ...Array.from(nodes.values()).map((n) => n.totalCount));
  nodes.forEach((n) => {
    const p = positions.get(n.key);
    if (!p) return;
    const r = n.isSeed ? 13 : 5 + Math.min(9, (n.totalCount / maxTotal) * 9);

    const group = svgEl("g", { class: "net-node" + (n.isSeed ? " seed" : "") + (n.expanded ? " expanded" : "") + (n.loading ? " loading" : "") });

    const title = svgEl("title", {});
    title.textContent = n.isSeed
      ? `${n.name} (seed)`
      : `${n.name} — ${n.totalCount} shared work${n.totalCount === 1 ? "" : "s"}${n.expanded ? " (expanded)" : " — click to expand"}`;
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

// --- Build / add seed / reset --------------------------------------------

async function buildFromSeeds(seedNames) {
  seedCardEl.style.display = "none";
  graphCardEl.style.display = "block";
  graphStatusLineEl.textContent = "Fetching seed authors' collaborators…";

  for (const name of seedNames) {
    const key = nodeKeyFor(name);
    if (!nodes.has(key)) {
      nodes.set(key, { key, name, hop: 0, isSeed: true, expanded: false, loading: false, totalCount: 0 });
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
  chrome.storage.local.remove([STORAGE_KEY]);
  graphCardEl.style.display = "none";
  seedCardEl.style.display = "block";
  seedRowsEl.innerHTML = "";
  addSeedField();
  addSeedField();
  updateBuildEnabled();
  statusLineEl.textContent = "";
});

// --- Init ------------------------------------------------------------------

(async function init() {
  const saved = await loadState();
  if (saved && saved.nodes && saved.nodes.length > 0) {
    nodes = new Map(saved.nodes.map((n) => [n.key, { ...n, loading: false }]));
    edges = new Map(saved.edges || []);
    seedCardEl.style.display = "none";
    graphCardEl.style.display = "block";
    graphStatusLineEl.textContent = `Resumed map — ${nodes.size} people, ${edges.size} connections.`;
    renderGraph();
  } else {
    addSeedField();
    addSeedField();
    updateBuildEnabled();
  }
})();
