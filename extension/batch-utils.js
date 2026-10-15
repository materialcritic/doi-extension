// Shared by the batch-download pages: a small worker pool so a batch runs a
// few downloads at once, plus the "likely hits first" ordering.

// Kept low on purpose: every download races all Sci-Hub mirrors on its own,
// and the mirrors' file backend rate-limits (429) a fast batch hard.
const BATCH_CONCURRENCY = 3;
// Spaces out the first wave so the opening mirror races don't all fire at once.
const BATCH_START_STAGGER_MS = 700;

async function runBatchPool(items, worker, concurrency = BATCH_CONCURRENCY) {
  let next = 0;
  const lane = async (laneIndex) => {
    if (laneIndex > 0) await new Promise((r) => setTimeout(r, laneIndex * BATCH_START_STAGGER_MS));
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        console.error("Batch item failed:", err);
      }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
}

// Crossref and OpenAlex type names for book content — Sci-Hub's coverage of
// book chapters is far thinner than of journal articles.
const BOOK_TYPES = new Set([
  "book-chapter", "book", "book-part", "book-section", "book-track", "book-set",
  "book-series", "edited-book", "monograph", "reference-book", "reference-entry",
]);

const LIKELY_UNAVAILABLE_MIN_TRIED = 5;
const LIKELY_UNAVAILABLE_MAX_RATE = 0.15;

function doiPrefix(doi) {
  return String(doi || "").trim().toLowerCase().split("/")[0];
}

// hitRates is {prefix: [ok, total]} from the user's own download history
// (native host's prefix_hit_rates action).
function isLikelyUnavailable(doi, hitRates) {
  const rate = hitRates && hitRates[doiPrefix(doi)];
  return !!rate && rate[1] >= LIKELY_UNAVAILABLE_MIN_TRIED && rate[0] / rate[1] < LIKELY_UNAVAILABLE_MAX_RATE;
}

// 0 = journal articles (and anything untyped), 1 = books/chapters,
// 2 = publishers whose papers have almost never downloaded before.
function downloadTier(work, hitRates) {
  if (isLikelyUnavailable(work.doi, hitRates)) return 2;
  if (BOOK_TYPES.has(work.type)) return 1;
  return 0;
}

// Stable within each tier, so the user's own sort order still applies.
function orderForDownload(items, getWork, hitRates) {
  return items
    .map((item, pos) => ({ item, pos, tier: downloadTier(getWork(item), hitRates) }))
    .sort((a, b) => a.tier - b.tier || a.pos - b.pos)
    .map((x) => x.item);
}

function fetchPrefixHitRates() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getPrefixHitRates" }, (resp) => {
      void chrome.runtime.lastError;
      resolve((resp && resp.success && resp.rates) || {});
    });
  });
}

// Only labels an idle row (blank or "Pending"), never one showing a real
// result like "Already downloaded ✓".
function markIfLikelyUnavailable(statusEl, doi, hitRates) {
  if (!statusEl || !doi || !isLikelyUnavailable(doi, hitRates)) return;
  if (statusEl.textContent && statusEl.textContent !== "Pending") return;
  statusEl.textContent = "Likely unavailable";
  statusEl.className = "work-status likely";
  statusEl.title = "Papers from this publisher have almost never been found before, so this one is tried last.";
}

// ---- Batch summary -------------------------------------------------------
const FAILURE_LABELS = {
  notfound: "not on Sci-Hub",
  corrupt: "corrupt file",
  cloudflare: "Cloudflare",
  blocked: "blocked by publisher",
  network: "network",
  other: "other",
};

function classifyFailure(resp) {
  const result = resp && resp.result;
  if (result && result.status === "corrupt") return "corrupt";
  if (result && result.status === "cloudflare_challenge") return "cloudflare";
  const detail = String((result && result.detail) || (resp && resp.error) || "");
  if (/No PDF found/i.test(detail)) return "notfound";
  if (/cloudflare/i.test(detail)) return "cloudflare";
  if (/\b(401|403|404|405|451)\b/.test(detail)) return "blocked";
  if (/connection|timed? ?out|timeout|max retries|disconnected|network|gateway|\b50[0-9]\b|SSL|native host/i.test(detail)) return "network";
  return "other";
}

function createBatchTally() {
  const counts = {};
  const failures = [];
  return {
    counts,
    failures,
    record(work, resp) {
      const key = classifyFailure(resp);
      counts[key] = (counts[key] || 0) + 1;
      const result = resp && resp.result;
      failures.push({
        doi: work.doi || "",
        title: work.title || "",
        reason: FAILURE_LABELS[key],
        detail: String((result && result.detail) || (resp && resp.error) || "").slice(0, 200),
      });
    },
  };
}

// Puts a one-line breakdown ("63 downloaded, 41 not on Sci-Hub, 3 Cloudflare")
// under `afterEl`, plus an export button when anything failed.
function renderBatchSummary(afterEl, tally, done, fileLabel) {
  if (!afterEl) return;
  let box = document.getElementById("batch-summary");
  if (box) box.remove();
  box = document.createElement("div");
  box.id = "batch-summary";
  box.style.cssText = "margin: 8px 0; font-size: 13px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;";
  const parts = [`${done} downloaded`];
  for (const key of Object.keys(FAILURE_LABELS)) {
    if (tally.counts[key]) parts.push(`${tally.counts[key]} ${FAILURE_LABELS[key]}`);
  }
  const text = document.createElement("span");
  text.textContent = parts.join(", ");
  box.appendChild(text);

  if (tally.failures.length > 0) {
    const btn = document.createElement("button");
    btn.textContent = `Export ${tally.failures.length} failed as list`;
    btn.addEventListener("click", () => {
      const lines = ["DOI\tReason\tTitle\tDetail", ...tally.failures.map((f) => [f.doi, f.reason, f.title, f.detail].map((v) => v.replace(/\s+/g, " ")).join("\t"))];
      const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/tab-separated-values" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `failed-downloads - ${String(fileLabel || "batch").replace(/[^\w\- ]/g, "")}.tsv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    box.appendChild(btn);
  }
  afterEl.insertAdjacentElement("afterend", box);
}
