'use strict';

// ---------------------------------------------------------------------------
// node_id construction.
//
// The slug algorithm is fixed by the published schema and must not be
// "improved": existing vaults contain node_ids built with it, and cross-refs
// resolve by exact string match. Lowercase, collapse runs of whitespace to a
// single hyphen, strip anything that is not a-z, 0-9, or hyphen — in that
// order. It can legitimately produce runs of hyphens ("a - b" -> "a---b");
// that is the documented behaviour, not a bug to normalize away.
// ---------------------------------------------------------------------------

function slug(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// A heading made entirely of punctuation ("***", "---") slugs to the empty
// string, which would produce a node_id with a missing component. Falling back
// to the heading's source line keeps the id unique and still fully determined
// by the source file.
function slugOrLine(text, line) {
  const s = slug(text);
  return s === '' ? `n${line}` : s;
}

// Underscores are only ever level separators in a node_id — slug() never
// produces one — so the ancestor chain stays unambiguously splittable.
function buildNodeId(stem, ancestorSlugs, ownSlug) {
  return [stem].concat(ancestorSlugs, [ownSlug]).join('_');
}

// Two siblings can carry identical heading text ("Parameters" under several
// endpoints), which would collide. Disambiguate by document order with a
// numeric suffix: the first keeps the bare slug, later ones get -2, -3, ...
// Deterministic given the same source, which is what matters.
function dedupe(slugs) {
  const seen = new Map();
  return slugs.map(s => {
    const count = (seen.get(s) || 0) + 1;
    seen.set(s, count);
    return count === 1 ? s : `${s}-${count}`;
  });
}

module.exports = { slug, slugOrLine, buildNodeId, dedupe };
