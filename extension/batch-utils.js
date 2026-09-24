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
