// Shared by author.js/issue.js/search.js's "Find Similar" links — crude
// keyword extraction (strip stopwords, keep the n most frequent remaining
// 4+ letter words) used to seed search.html's Crossref bibliographic search.
const STOPWORDS = new Set([
  "the", "and", "of", "in", "to", "a", "is", "that", "this", "for", "are", "on", "with", "as", "by",
  "an", "be", "was", "were", "or", "from", "its", "it", "which", "these", "those", "we", "our",
  "their", "have", "has", "had", "not", "but", "between", "can", "also", "such", "than", "other",
  "more", "most", "however", "study", "paper", "article", "results", "using", "based", "within",
  "among", "both", "each", "been", "into", "when", "while", "then", "than", "them", "they", "there",
]);

function extractKeywords(text, n = 6) {
  const counts = new Map();
  (text.toLowerCase().match(/[a-z]{4,}/g) || []).forEach((w) => {
    if (STOPWORDS.has(w)) return;
    counts.set(w, (counts.get(w) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}
