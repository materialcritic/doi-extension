// Guards against double-injection: the manifest auto-injects this file on
// every page load, and popup.js's scanPage() also injects it as a fallback
// for tabs that were already open before the extension loaded. Re-running
// the whole file a second time would throw on the top-level const/let
// redeclarations, so skip everything if we've already run once.
if (!window.__doiGrabberLoaded) {
window.__doiGrabberLoaded = true;

// DOI patterns to match both URL and text forms
const DOI_PATTERNS = [
  // Standard DOI in page text: "DOI: 10.xxxx/..." or "doi:10.xxxx/..."
  /\bdoi[:\s]+\s*(10\.\d{4,}(?:\.\d+)*\/[^\s,;\])"'>]+)/i,
  // doi.org URL form: https://doi.org/10.xxxx/...
  /doi\.org\/(10\.\d{4,}(?:\.\d+)*\/[^\s,;\])"'>]+)/i,
  // Bare DOI: 10.xxxx/...  (must start with 10.)
  /\b(10\.\d{4,}(?:\.\d+)*\/[^\s,;\])"'>]+)/,
];

function findDOI() {
  // 1. Check the page URL first
  const urlDOI = window.location.href.match(/doi\.org\/(10\.\d{4,}[^\s&?#]+)/);
  if (urlDOI) return cleanDOI(urlDOI[1]);

  // 2. Check <meta> tags (many publisher sites embed DOI here)
  const metaTags = document.querySelectorAll('meta[name*="doi"], meta[property*="doi"], meta[name="citation_doi"]');
  for (const tag of metaTags) {
    const content = tag.getAttribute("content");
    if (content && content.startsWith("10.")) return cleanDOI(content);
  }

  // 3. Scan visible page text — prioritise structured elements first
  const prioritySelectors = [
    ".doi", '[class*="doi"]', '[id*="doi"]',
    ".article-meta", ".citation", ".metadata",
    "p", "span", "a", "li"
  ];

  for (const selector of prioritySelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const text = el.textContent || "";
      for (const pattern of DOI_PATTERNS) {
        const match = text.match(pattern);
        if (match) return cleanDOI(match[1] || match[0]);
      }
    }
  }

  // 4. Last resort: scan the entire page's visible text, in case the DOI
  // sits inside a tag type not covered above (e.g. <div>, <td>).
  const bodyText = document.body.innerText || "";
  for (const pattern of DOI_PATTERNS) {
    const match = bodyText.match(pattern);
    if (match) return cleanDOI(match[1] || match[0]);
  }

  return null;
}

function cleanDOI(doi) {
  // Strip trailing punctuation that may have been captured
  return doi.replace(/[.,;)\]}"'>]+$/, "").trim();
}

// Pull the paper's title and author(s) from meta tags, for use as a
// fallback search query when the DOI itself isn't downloadable.
function findMetadata() {
  let authors = Array.from(document.querySelectorAll('meta[name="citation_author" i]'))
    .map((tag) => tag.getAttribute("content"))
    .filter(Boolean);

  if (authors.length === 0) {
    // "dc.creator" is case-inconsistent across publishers (dc.Creator,
    // DC.creator, DC.Creator, ...) — CSS attribute selectors are
    // case-sensitive by default, so match name= case-insensitively.
    const authorTag = document.querySelector('meta[name="author" i], meta[name="dc.creator" i]');
    if (authorTag && authorTag.getAttribute("content")) {
      authors = [authorTag.getAttribute("content")];
    }
  }

  if (authors.length === 0) {
    // Some paywalled pages (e.g. SAGE) skip citation/author meta tags
    // entirely but still mark up the byline with schema.org Person
    // microdata — fall back to scraping that.
    const authorEls = document.querySelectorAll('[property="author"][typeof="Person"], [itemprop="author"]');
    authors = Array.from(authorEls)
      .map((el) => {
        const given = el.querySelector('[property="givenName"]')?.textContent.trim();
        const family = el.querySelector('[property="familyName"]')?.textContent.trim();
        if (given || family) return [given, family].filter(Boolean).join(" ");
        return el.textContent.trim();
      })
      .filter(Boolean);
  }

  const titleTag = document.querySelector(
    'meta[name="citation_title"], meta[property="og:title"], meta[name="dc.title"], meta[name="DC.title"]'
  );
  let title = (titleTag && titleTag.getAttribute("content")) || document.title || "";

  // document.title is often formatted "Author, Title - SiteName" (seen on
  // PhilPapers, for example) when there's no dedicated title meta tag. Strip
  // both parts so we don't end up duplicating the author in a search query
  // built from title + author separately.
  for (const author of authors) {
    if (author && title.startsWith(author + ", ")) {
      title = title.slice(author.length + 2);
      break;
    }
  }
  title = title.replace(/\s+[-|–]\s+[^-|–]{1,40}$/, "");

  return { title: title.trim(), authors };
}

// Respond to a message from popup.js asking for the DOI
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "getDOI") {
    const doi = findDOI();
    const { title, authors } = findMetadata();
    sendResponse({ doi, title, authors });
  }
});

// Auto-run on page load so the background script can check availability
// and badge the toolbar icon without the popup being opened.
const autoDetectedDOI = findDOI();
if (autoDetectedDOI) {
  const { title, authors } = findMetadata();
  chrome.runtime.sendMessage({ action: "doiDetected", doi: autoDetectedDOI, title, authors });
}

} // end __doiGrabberLoaded guard
