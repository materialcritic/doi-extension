(function () {
  const svg = document.getElementById("svg");
  const vp = document.getElementById("vp");
  const tip = document.getElementById("tip");
  const empty = document.getElementById("empty");
  const NS = "http://www.w3.org/2000/svg";
  const abstractCache = {};

  // Cached so a theme change can redraw without re-reading storage.
  let lastGraphData = null;

  chrome.storage.local.get("snowballGraph", (res) => {
    const g = res && res.snowballGraph;
    if (!g || !g.nodes || !g.nodes.length) return; // keep #empty visible
    empty.style.display = "none";
    lastGraphData = g;
    render(g, true);
  });

  // Node/edge fill/stroke/text colors are baked into SVG attributes from
  // cssVar() at draw time — not live `var(--x)` CSS references — so they
  // never repaint on their own when the theme changes (unlike the header/
  // background, which use real CSS variables and update automatically).
  // Redraw explicitly whenever theme.js flips the active theme.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.theme || changes.lightTheme) && lastGraphData) {
      setTimeout(() => render(lastGraphData, false), 0);
    }
  });

  function el(n, a) { const e = document.createElementNS(NS, n); for (const k in (a || {})) e.setAttribute(k, a[k]); return e; }
  function norm(d) { return String(d || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, ""); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
  function hexA(hex, a) { const m = hex.replace("#", ""); if (m.length !== 6) return hex; const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16); return "rgba(" + r + "," + g + "," + b + "," + a + ")"; }
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

  function render(g, isInitial) {
    const seed = g.seed || {};
    const seedDoi = norm(seed.doi);
    const nodes = g.nodes.slice();
    if (!nodes.some((n) => norm(n.doi) === seedDoi && n.via === "seed")) {
      nodes.unshift({ doi: seedDoi, title: seed.title || "Seed paper", author: seed.author || "", depth: 0, via: "seed" });
    }

    vp.innerHTML = ""; // clear the previous draw (matters on a theme-change redraw)

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
    const totalW = (colKeys.length - 1) * COLW + NODEW;

    // edges (drawn first, under nodes)
    const drawn = {};
    (g.edges || []).forEach((e) => {
      const a = pos[norm(e.from)], b = pos[norm(e.to)];
      if (!a || !b) return;
      const key = norm(e.from) + ">" + norm(e.to);
      if (drawn[key]) return; drawn[key] = 1;
      const col = b.node.via === "forward" ? cssVar("--coral") : cssVar("--teal");
      let sx, sy, ex, ey;
      if (b.x < a.x) { sx = a.x; sy = a.y + a.h / 2; ex = b.x + b.w; ey = b.y + b.h / 2; }
      else { sx = a.x + a.w; sy = a.y + a.h / 2; ex = b.x; ey = b.y + b.h / 2; }
      const mx = (sx + ex) / 2;
      vp.appendChild(el("path", { d: "M " + sx + " " + sy + " C " + mx + " " + sy + " " + mx + " " + ey + " " + ex + " " + ey, class: "edge", stroke: col }));
    });

    // nodes
    Object.keys(pos).forEach((doi) => {
      const p = pos[doi], n = p.node;
      const accent = n.via === "seed" ? cssVar("--purple") : (n.via === "forward" ? cssVar("--coral") : cssVar("--teal"));
      const grp = el("g", {});
      grp.style.cursor = "pointer";
      grp.appendChild(el("rect", { x: p.x, y: p.y, width: p.w, height: p.h, rx: 6, fill: hexA(accent, 0.14), stroke: accent, "stroke-width": 0.5 }));
      const label = n.title && n.title.trim() ? n.title : doi;
      const lines = wrapTitle(label, 30, 2);
      const titleTop = p.y + 17;
      lines.forEach((ln, i) => {
        const t = el("text", { x: p.x + 10, y: titleTop + i * 15, "font-size": 12, fill: cssVar("--text") });
        t.textContent = ln;
        grp.appendChild(t);
      });
      if (n.author && n.author.trim()) {
        const at = el("text", { x: p.x + 10, y: titleTop + lines.length * 15 + 5, "font-size": 10.5, fill: cssVar("--text-dim") });
        at.textContent = truncate(n.author, 34);
        grp.appendChild(at);
      }
      grp.addEventListener("mouseenter", (ev) => showTip(ev, n, doi));
      grp.addEventListener("mousemove", moveTip);
      grp.addEventListener("mouseleave", hideTip);
      vp.appendChild(grp);
    });

    if (isInitial) {
      fitView(pos[seedDoi], totalW, maxH);
      wirePanZoom();
    }
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
  // instead of fetching OpenAlex directly here — reuses its OpenAlex-first/
  // Crossref-fallback chain and the Tandfonline mis-scrape filter rather than
  // duplicating (and losing) that coverage in a second, page-local copy.
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

  // ---- pan / zoom ----
  let tx = 0, ty = 0, scale = 1;
  function apply() { vp.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + scale + ")"); }
  function fitView(seedPos, totalW, totalH) {
    const r = svg.getBoundingClientRect();
    scale = 1;
    if (seedPos) { tx = r.width / 2 - (seedPos.x + seedPos.w / 2); ty = r.height / 2 - (seedPos.y + seedPos.h / 2); }
    else { tx = (r.width - totalW) / 2; ty = (r.height - totalH) / 2; }
    apply();
  }
  function wirePanZoom() {
    let dragging = false, lx = 0, ly = 0;
    svg.addEventListener("mousedown", (e) => { e.preventDefault(); hideTip(); dragging = true; lx = e.clientX; ly = e.clientY; svg.classList.add("drag"); });
    window.addEventListener("mouseup", () => { dragging = false; svg.classList.remove("drag"); });
    window.addEventListener("mousemove", (e) => { if (!dragging) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.max(0.2, Math.min(3, scale * f));
      tx = mx - (mx - tx) * (ns / scale); ty = my - (my - ty) * (ns / scale); scale = ns; apply();
    }, { passive: false });
  }
})();
