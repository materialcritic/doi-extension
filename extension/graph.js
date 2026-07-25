(function () {
  const svg = document.getElementById("svg");
  const vp = document.getElementById("vp");
  const tip = document.getElementById("tip");
  const empty = document.getElementById("empty");
  const dirSeg = document.getElementById("dir-seg");
  const depthSeg = document.getElementById("depth-seg");
  const NS = "http://www.w3.org/2000/svg";
  const abstractCache = {};

  let graph = null;        // { seed, nodes, edges }
  let viewDir = "both";    // "backward" | "both" | "forward"
  let viewDepth = 1;       // show hops <= viewDepth
  let maxDepth = 1;
  let seedDoiG = "";
  let panZoomWired = false;

  chrome.storage.local.get("snowballGraph", (res) => {
    const g = res && res.snowballGraph;
    if (!g || !g.nodes || !g.nodes.length) return; // keep #empty visible
    empty.style.display = "none";
    graph = g;

    const seed = g.seed || {};
    seedDoiG = norm(seed.doi);
    if (!g.nodes.some((n) => norm(n.doi) === seedDoiG && n.via === "seed")) {
      g.nodes.unshift({ doi: seedDoiG, title: seed.title || "Seed paper", author: seed.author || "", depth: 0, via: "seed" });
    }

    maxDepth = g.nodes.reduce((m, n) => Math.max(m, n.depth || 0), 1);
    viewDepth = maxDepth; // show everything on first open
    buildDepthButtons();
    wireControls();

    render("full");
    if (!panZoomWired) { wirePanZoom(); panZoomWired = true; }
  });

  function el(n, a) { const e = document.createElementNS(NS, n); for (const k in (a || {})) e.setAttribute(k, a[k]); return e; }
  function norm(d) { return String(d || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, ""); }
  function truncate(s, max) { s = String(s || ""); return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, "") + "…" : s; }

  function colIndex(n) { return n.via === "seed" ? 0 : (n.via === "backward" ? -n.depth : n.depth); }

  function wrapTitle(title, maxChars, maxLines) {
    const words = String(title || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length <= maxChars) cur = (cur + " " + w).trim();
      else { if (cur) lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    const shown = lines.join(" ");
    if (shown.length < String(title || "").length && lines.length) {
      let last = lines[lines.length - 1];
      if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
      lines[lines.length - 1] = last.replace(/\s+$/, "") + "…";
    }
    return lines.length ? lines : ["(untitled)"];
  }

  const NODEW = 180, NODEH = 62, GAPV = 14, COLW = 220;

  // Client-side filter: seed always shown; direction hides one side; depth caps hops.
  function visibleNodes() {
    return graph.nodes.filter((n) => {
      if (n.via === "seed") return true;
      if (viewDir === "backward" && n.via !== "backward") return false;
      if (viewDir === "forward" && n.via !== "forward") return false;
      if ((n.depth || 0) > viewDepth) return false;
      return true;
    });
  }

  // fitMode: "full" (reset zoom + center seed) | "recenter" (keep zoom, center seed) | "none"
  function render(fitMode) {
    if (!graph) return;
    vp.innerHTML = "";

    const nodes = visibleNodes();
    const colMap = {};
    nodes.forEach((n) => { const c = colIndex(n); (colMap[c] = colMap[c] || []).push(n); });
    const colKeys = Object.keys(colMap).map(Number).sort((a, b) => a - b);

    let maxH = 0;
    colKeys.forEach((c) => { const k = colMap[c].length; maxH = Math.max(maxH, k * NODEH + (k - 1) * GAPV); });

    const pos = {};
    colKeys.forEach((c, ci) => {
      const arr = colMap[c], k = arr.length, block = k * NODEH + (k - 1) * GAPV;
      const startY = (maxH - block) / 2, x = ci * COLW;
      arr.forEach((n, j) => { pos[norm(n.doi)] = { x, y: startY + j * (NODEH + GAPV), w: NODEW, h: NODEH, node: n }; });
    });
    const totalW = colKeys.length ? (colKeys.length - 1) * COLW + NODEW : NODEW;

    // edges (drawn first, under nodes); classes carry the color (live CSS vars)
    const drawn = {};
    (graph.edges || []).forEach((e) => {
      const a = pos[norm(e.from)], b = pos[norm(e.to)];
      if (!a || !b) return; // an endpoint filtered out
      const key = norm(e.from) + ">" + norm(e.to);
      if (drawn[key]) return; drawn[key] = 1;
      const ecls = b.node.via === "forward" ? "edge-fwd" : "edge-back";
      let sx, sy, ex, ey;
      if (b.x < a.x) { sx = a.x; sy = a.y + a.h / 2; ex = b.x + b.w; ey = b.y + b.h / 2; }
      else { sx = a.x + a.w; sy = a.y + a.h / 2; ex = b.x; ey = b.y + b.h / 2; }
      const mx = (sx + ex) / 2;
      vp.appendChild(el("path", { d: "M " + sx + " " + sy + " C " + mx + " " + sy + " " + mx + " " + ey + " " + ex + " " + ey, class: "edge " + ecls }));
    });

    // nodes — color via class, doi via data-attr (used for click-to-open)
    Object.keys(pos).forEach((doi) => {
      const p = pos[doi], n = p.node;
      const sideClass = n.via === "seed" ? "n-seed" : (n.via === "forward" ? "n-fwd" : "n-back");
      const grp = el("g", { class: "gnode " + sideClass, "data-doi": doi });
      grp.appendChild(el("rect", { x: p.x, y: p.y, width: p.w, height: p.h, rx: 6 }));
      const label = n.title && n.title.trim() ? n.title : doi;
      const lines = wrapTitle(label, 30, 2);
      const titleTop = p.y + 17;
      lines.forEach((ln, i) => {
        const t = el("text", { x: p.x + 10, y: titleTop + i * 15, class: "n-title" });
        t.textContent = ln;
        grp.appendChild(t);
      });
      if (n.author && n.author.trim()) {
        const at = el("text", { x: p.x + 10, y: titleTop + lines.length * 15 + 5, class: "n-author" });
        at.textContent = truncate(n.author, 34);
        grp.appendChild(at);
      }
      grp.addEventListener("mouseenter", (ev) => showTip(ev, n, doi));
      grp.addEventListener("mousemove", moveTip);
      grp.addEventListener("mouseleave", hideTip);
      vp.appendChild(grp);
    });

    const seedPos = pos[seedDoiG] || null;
    if (fitMode === "full") fitView(seedPos, totalW, maxH, true);
    else if (fitMode === "recenter") fitView(seedPos, totalW, maxH, false);
  }

  // ---- Direction / Depth controls ----
  function buildDepthButtons() {
    depthSeg.innerHTML = "";
    for (let d = 1; d <= maxDepth; d++) {
      const b = document.createElement("button");
      b.textContent = String(d);
      b.dataset.depth = String(d);
      if (d === viewDepth) b.classList.add("on");
      depthSeg.appendChild(b);
    }
  }
  function wireControls() {
    dirSeg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-dir]"); if (!b) return;
      viewDir = b.dataset.dir;
      [].forEach.call(dirSeg.children, (c) => c.classList.toggle("on", c === b));
      render("recenter");
    });
    depthSeg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-depth]"); if (!b) return;
      viewDepth = parseInt(b.dataset.depth, 10);
      [].forEach.call(depthSeg.children, (c) => c.classList.toggle("on", c === b));
      render("recenter");
    });
  }

  // ---- tooltip + lazy abstract ----
  let tipDoi = null;
  function showTip(ev, n, doi) {
    tipDoi = doi;
    const title = (n.title && n.title.trim()) ? n.title : doi;
    tip.innerHTML = '<div class="t"></div><div class="au"></div><div class="a">Loading abstract…</div><div class="d"></div>';
    tip.querySelector(".t").textContent = title;
    const auEl = tip.querySelector(".au");
    if (n.author && n.author.trim()) auEl.textContent = n.author;
    else auEl.style.display = "none";
    tip.querySelector(".d").textContent = doi;
    tip.style.display = "block";
    moveTip(ev);
    loadAbstract(doi).then((txt) => {
      if (tipDoi !== doi) return;
      tip.querySelector(".a").textContent = txt || "No abstract available for this paper.";
    });
  }
  function moveTip(ev) {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight) y = ev.clientY - h - pad;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip() { tipDoi = null; tip.style.display = "none"; }

  // Routes through the existing getWorkAbstract message action (background.js)
  // to reuse its OpenAlex-first / Crossref-fallback chain and Tandfonline filter.
  async function loadAbstract(doi) {
    if (doi in abstractCache) return abstractCache[doi];
    let txt = "";
    try {
      const resp = await chrome.runtime.sendMessage({ action: "getWorkAbstract", doi });
      if (resp && resp.success) txt = resp.abstract || "";
    } catch (e) { /* leave blank */ }
    abstractCache[doi] = txt;
    return txt;
  }

  // ---- pan / zoom + click-to-open ----
  let tx = 0, ty = 0, scale = 1;
  function apply() { vp.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + scale + ")"); }
  function fitView(seedPos, totalW, totalH, resetScale) {
    const r = svg.getBoundingClientRect();
    if (resetScale) scale = 1;
    if (seedPos) { tx = r.width / 2 - (seedPos.x + seedPos.w / 2) * scale; ty = r.height / 2 - (seedPos.y + seedPos.h / 2) * scale; }
    else { tx = (r.width - totalW * scale) / 2; ty = (r.height - totalH * scale) / 2; }
    apply();
  }
  function wirePanZoom() {
    let dragging = false, moved = false, lx = 0, ly = 0, downDoi = null;
    svg.addEventListener("mousedown", (e) => {
      e.preventDefault(); hideTip();
      dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
      const g = e.target.closest ? e.target.closest("[data-doi]") : null;
      downDoi = g ? g.getAttribute("data-doi") : null;
      svg.classList.add("drag");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 4) moved = true;
      tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
    });
    window.addEventListener("mouseup", () => {
      // A press with no meaningful drag, started on a node = a click -> open it.
      if (dragging && !moved && downDoi) chrome.tabs.create({ url: "https://doi.org/" + downDoi });
      dragging = false; downDoi = null; svg.classList.remove("drag");
    });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.max(0.2, Math.min(3, scale * f));
      tx = mx - (mx - tx) * (ns / scale); ty = my - (my - ty) * (ns / scale); scale = ns; apply();
    }, { passive: false });
  }
})();
