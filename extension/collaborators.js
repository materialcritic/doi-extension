document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  window.toggleTheme();
});

const authorNameEl = document.getElementById("author-name");
const subtitleEl = document.getElementById("subtitle");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("list");
const graphViewEl = document.getElementById("graph-view");
const viewToolbarEl = document.getElementById("view-toolbar");
const btnToggleView = document.getElementById("btn-toggle-view");

const GRAPH_MAX_NODES = 20; // keeps the radial layout legible for prolific authors

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// Simple radial layout — target author at the center, top collaborators
// spaced evenly around a circle, edges both to the center (co-authored with
// the target) and between collaborators themselves (co-authored with each
// other on the same work). Not force-directed; good enough for a few dozen
// nodes and avoids pulling in a graphing library for a vanilla-JS page.
function renderNetworkGraph(authorName, collaborators, edges) {
  const size = 640;
  const center = size / 2;
  const radius = size * 0.38;

  const top = collaborators.slice(0, GRAPH_MAX_NODES);
  const topKeys = new Set(top.map((c) => c.key));
  const maxCount = top[0] ? top[0].count : 1;

  const positions = new Map(); // key -> { x, y }
  top.forEach((c, i) => {
    const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(c.key, {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    });
  });

  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, xmlns: "http://www.w3.org/2000/svg" });

  // Edges between collaborators (drawn first so nodes/labels sit on top)
  const pairEdgeMax = edges.reduce((m, e) => Math.max(m, e.count), 1);
  edges.forEach((e) => {
    if (!topKeys.has(e.a) || !topKeys.has(e.b)) return;
    const pa = positions.get(e.a);
    const pb = positions.get(e.b);
    svg.appendChild(svgEl("line", {
      x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
      stroke: "var(--border)",
      "stroke-width": 1 + (e.count / pairEdgeMax) * 2,
      opacity: 0.6,
    }));
  });

  // Edges from the target author (center) to each collaborator
  top.forEach((c) => {
    const p = positions.get(c.key);
    svg.appendChild(svgEl("line", {
      x1: center, y1: center, x2: p.x, y2: p.y,
      stroke: "var(--accent)",
      "stroke-width": 0.75 + (c.count / maxCount) * 2.5,
      opacity: 0.4,
    }));
  });

  // Center node (target author)
  const centerGroup = svgEl("g", {});
  centerGroup.appendChild(svgEl("circle", { cx: center, cy: center, r: 12, fill: "var(--text)" }));
  const centerLabel = svgEl("text", { x: center, y: center + 26, "text-anchor": "middle", class: "graph-center-label" });
  centerLabel.textContent = authorName;
  centerGroup.appendChild(centerLabel);
  svg.appendChild(centerGroup);

  // Collaborator nodes, each wrapped in a clickable <a> linking to their own works page
  top.forEach((c) => {
    const p = positions.get(c.key);
    const r = 4 + (c.count / maxCount) * 10;

    const link = svgEl("a", {});
    link.setAttribute("href", chrome.runtime.getURL("author.html") + "?author=" + encodeURIComponent(c.name));
    link.setAttribute("target", "_blank");
    link.setAttribute("class", "graph-node");

    const title = svgEl("title", {});
    title.textContent = `${c.name} — ${c.count} shared work${c.count === 1 ? "" : "s"}`;
    link.appendChild(title);

    link.appendChild(svgEl("circle", { cx: p.x, cy: p.y, r }));

    const labelY = p.y + (p.y > center ? r + 12 : -r - 6);
    const label = svgEl("text", { x: p.x, y: labelY, "text-anchor": "middle", class: "graph-node-label" });
    label.textContent = c.name.length > 22 ? c.name.slice(0, 20) + "…" : c.name;
    link.appendChild(label);

    svg.appendChild(link);
  });

  graphViewEl.innerHTML = "";
  graphViewEl.appendChild(svg);

  if (collaborators.length > GRAPH_MAX_NODES) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = `Showing top ${GRAPH_MAX_NODES} of ${collaborators.length} collaborators by shared works.`;
    graphViewEl.appendChild(hint);
  }
}

let lastCollaborators = [];
let lastEdges = [];
let graphBuilt = false;

// Graph and list are shown together (graph on top, list below) rather than
// as mutually-exclusive views — this toggle only hides/shows the graph.
btnToggleView.addEventListener("click", () => {
  const showingGraph = graphViewEl.style.display !== "none";
  if (showingGraph) {
    graphViewEl.style.display = "none";
    document.body.classList.remove("graph-active");
    btnToggleView.textContent = "Show Network Graph";
  } else {
    if (!graphBuilt) {
      renderNetworkGraph(authorName, lastCollaborators, lastEdges);
      graphBuilt = true;
    }
    graphViewEl.style.display = "block";
    document.body.classList.add("graph-active");
    btnToggleView.textContent = "Hide Network Graph";
  }
});

const params = new URLSearchParams(window.location.search);
const authorName = params.get("author") || "";

authorNameEl.textContent = authorName ? `${authorName}'s collaborators` : "Unknown author";

if (!authorName) {
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  errorEl.textContent = "No author name provided.";
  subtitleEl.textContent = "";
} else {
  chrome.runtime.sendMessage({ action: "getCollaborators", author: authorName }, (resp) => {
    loadingEl.style.display = "none";

    if (!resp || !resp.success) {
      errorEl.style.display = "block";
      errorEl.textContent = "Couldn't search Crossref: " + (resp?.error || "Unknown error");
      subtitleEl.textContent = "";
      return;
    }

    const collaborators = resp.collaborators || [];
    subtitleEl.textContent = `${collaborators.length} co-authors found across ${resp.sampledWorks} sampled works`;

    if (collaborators.length === 0) {
      emptyEl.style.display = "block";
      return;
    }

    lastCollaborators = collaborators;
    lastEdges = resp.edges || [];
    viewToolbarEl.style.display = "flex";

    // Network graph is open by default, with the list always visible below it.
    renderNetworkGraph(authorName, lastCollaborators, lastEdges);
    graphBuilt = true;
    graphViewEl.style.display = "block";
    document.body.classList.add("graph-active");

    const maxCount = collaborators[0].count;
    listEl.style.display = "block";
    collaborators.forEach((c) => {
      const row = document.createElement("a");
      row.className = "collab-row";
      row.href = chrome.runtime.getURL("author.html") + "?author=" + encodeURIComponent(c.name);
      row.target = "_blank";

      const nameEl = document.createElement("div");
      nameEl.className = "collab-name";
      nameEl.textContent = c.name;

      const barWrap = document.createElement("div");
      barWrap.style.width = "80px";
      barWrap.style.flexShrink = "0";
      const bar = document.createElement("div");
      bar.className = "collab-bar";
      bar.style.width = Math.max(6, Math.round((c.count / maxCount) * 80)) + "px";
      barWrap.appendChild(bar);

      const countEl = document.createElement("div");
      countEl.className = "collab-count";
      countEl.textContent = c.count + " paper" + (c.count === 1 ? "" : "s");

      row.appendChild(nameEl);
      row.appendChild(barWrap);
      row.appendChild(countEl);
      listEl.appendChild(row);
    });
  });
}
