'use strict';

// ---------------------------------------------------------------------------
// Dependency-free text similarity.
//
// Jaccard overlap on lowercased token sets, with very common English function
// words removed so two summaries are judged on their content words rather than
// on how many times they both said "the". Deterministic, cheap, and good enough
// to catch the failure it exists to catch: sibling summaries that restate each
// other because the model could not see what it was supposed to differ from.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'for',
  'from', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on',
  'or', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function jaccard(a, b) {
  const setA = a instanceof Set ? a : tokenSet(a);
  const setB = b instanceof Set ? b : tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

// Every pairwise comparison in a group, returning only those at or above the
// threshold. Groups here are always small (siblings of one parent, or the roots
// of one batch), so the quadratic cost is irrelevant.
function findSimilarPairs(items, threshold) {
  const prepared = items.map(i => ({ ref: i, set: tokenSet(i.text) }));
  const hits = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const score = jaccard(prepared[i].set, prepared[j].set);
      if (score > threshold) {
        hits.push({ a: prepared[i].ref, b: prepared[j].ref, score });
      }
    }
  }
  return hits;
}

module.exports = { tokenize, tokenSet, jaccard, findSimilarPairs, STOPWORDS };
