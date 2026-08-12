'use strict';

const markdown = require('./markdown');
const { slugOrLine, dedupe } = require('./slug');

// ---------------------------------------------------------------------------
// Deterministic tree skeleton construction.
//
// Everything structural is decided here: node shape, hierarchy, node_ids, line
// ranges, chunk boundaries, page ranges. Every `summary` comes out null — a
// model fills those in later and may change nothing else.
//
// The coverage contract this builds toward, and that validate.js checks
// independently:
//
//   Every substantive body line belongs to exactly one leaf's content_ref,
//   except the heading line of a non-leaf node, which is represented by that
//   node's `heading` field instead.
//
// The exception exists so a parent heading with children does not need a
// pointless one-line "overview" leaf just to satisfy coverage. When a parent
// does have real introductory prose before its first child, that prose does get
// an explicit `— Overview` leaf, because otherwise it would be unreachable.
// ---------------------------------------------------------------------------

const OVERVIEW_SUFFIX = ' — Overview';
const PART_SUFFIX = ' — Part ';
const PREAMBLE_HEADING = 'Preamble';
const UNTITLED = '(untitled section)';

function hasSubstantiveIn(parsed, start, end) {
  for (let n = Math.max(start, parsed.bodyStart); n <= end; n++) {
    if (parsed.substantive[n]) return true;
  }
  return false;
}

// Splits [start,end] into consecutive blocks of at most `size` lines.
function chunkRange(start, end, size) {
  const out = [];
  for (let s = start; s <= end; s += size) {
    out.push([s, Math.min(s + size - 1, end)]);
  }
  return out;
}

function buildHierarchy(parsed, domainEnd) {
  const headings = parsed.headings;
  const roots = [];
  const stack = [];

  headings.forEach((h, i) => {
    // A section runs until the next heading at the same or a higher level.
    let end = domainEnd;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) { end = headings[j].line - 1; break; }
    }
    const node = {
      heading: h.text && h.text.trim() !== '' ? h.text : UNTITLED,
      level: h.level,
      line: h.line,
      blockStart: h.line,
      blockEnd: Math.max(h.line, end),
      children: [],
    };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  });

  return roots;
}

// Turns hierarchy nodes into final shape: inserts overview leaves, splits
// oversized leaves, and assigns content_ref to leaves only.
function materialize(node, parsed, maxSectionLines) {
  if (node.children.length > 0) {
    const firstChildLine = node.children[0].line;
    const introEnd = firstChildLine - 1;
    // Real prose between this heading and its first child would otherwise be
    // unreachable, so it becomes an explicit leaf.
    if (introEnd > node.line && hasSubstantiveIn(parsed, node.line + 1, introEnd)) {
      node.children.unshift({
        heading: node.heading + OVERVIEW_SUFFIX,
        level: node.level + 1,
        line: node.line,
        blockStart: node.line,
        blockEnd: introEnd,
        children: [],
        generated: 'overview',
      });
    }
    node.children.forEach(c => materialize(c, parsed, maxSectionLines));
    return;
  }

  const span = node.blockEnd - node.blockStart + 1;
  if (maxSectionLines > 0 && span > maxSectionLines) {
    const parts = chunkRange(node.blockStart, node.blockEnd, maxSectionLines);
    node.children = parts.map((range, idx) => ({
      heading: node.heading + PART_SUFFIX + (idx + 1),
      level: node.level + 1,
      line: range[0],
      blockStart: range[0],
      blockEnd: range[1],
      children: [],
      generated: 'part',
    }));
  }
}

function assignIds(nodes, stem, ancestorSlugs) {
  const slugs = dedupe(nodes.map(n => slugOrLine(n.heading, n.line)));
  nodes.forEach((node, i) => {
    const own = slugs[i];
    node.node_id = [stem].concat(ancestorSlugs, [own]).join('_');
    if (node.children.length) assignIds(node.children, stem, ancestorSlugs.concat([own]));
  });
}

function emit(node, parsed, wantPages) {
  const out = {
    heading: node.heading,
    level: node.level,
    node_id: node.node_id,
    summary: null,
  };
  if (wantPages) {
    out.page_range = markdown.pageRangeFor(parsed.pageMarkers, node.blockStart, node.blockEnd);
  }
  out.children = node.children.map(c => emit(c, parsed, wantPages));
  if (node.children.length === 0) {
    out.content_ref = { lines: [node.blockStart, node.blockEnd] };
  }
  return out;
}

function countNodes(nodes) {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}

function maxDepth(nodes, depth) {
  return nodes.reduce((acc, n) => Math.max(acc, n.children.length ? maxDepth(n.children, depth + 1) : depth), depth);
}

function countLeaves(nodes) {
  return nodes.reduce((acc, n) => acc + (n.children.length ? countLeaves(n.children) : 1), 0);
}

/**
 * Builds a complete structural tree with every summary set to null.
 *
 * @param {object} opts
 * @param {object} opts.parsed        output of markdown.parse
 * @param {string} opts.relativePath  source path relative to ingestion_directory
 * @param {string} opts.stem          tree filename stem, prefix for every node_id
 * @param {string} opts.docType       resolved doc type
 * @param {object} opts.fingerprint   {line_count, sha256}
 * @param {object} opts.config        loaded config
 */
function buildSkeleton(opts) {
  const { parsed, relativePath, stem, docType, fingerprint, config } = opts;
  const wantPages = !!(config.source && config.source.page_numbers_in_citations);
  const maxSectionLines = config.chunking.max_section_size_lines;
  const fallbackChunk = config.chunking.fallback_chunk_size_lines;
  const domainEnd = parsed.lastSubstantiveLine;

  let roots = [];

  if (domainEnd >= parsed.bodyStart) {
    if (parsed.headings.length === 0) {
      // No headings at all: a flat run of fixed-size chunks under the root.
      roots = chunkRange(parsed.bodyStart, domainEnd, fallbackChunk).map((range, idx) => ({
        heading: `Chunk ${idx + 1}`,
        level: 1,
        line: range[0],
        blockStart: range[0],
        blockEnd: range[1],
        children: [],
        generated: 'chunk',
      }));
    } else {
      roots = buildHierarchy(parsed, domainEnd);
      // Content sitting above the first heading has no section to belong to.
      const firstHeadingLine = parsed.headings[0].line;
      if (firstHeadingLine > parsed.bodyStart && hasSubstantiveIn(parsed, parsed.bodyStart, firstHeadingLine - 1)) {
        roots.unshift({
          heading: PREAMBLE_HEADING,
          level: 1,
          line: parsed.bodyStart,
          blockStart: parsed.bodyStart,
          blockEnd: firstHeadingLine - 1,
          children: [],
          generated: 'preamble',
        });
      }
      roots.forEach(n => materialize(n, parsed, maxSectionLines));
    }
  }

  assignIds(roots, stem, []);

  const tree = {
    file: relativePath,
    doc_type: docType,
    root_summary: null,
    source_fingerprint: fingerprint,
    schema_version: 2,
  };
  if (wantPages) {
    tree.page_range = markdown.pageRangeFor(parsed.pageMarkers, parsed.bodyStart, domainEnd || parsed.bodyStart);
  }
  tree.children = roots.map(n => emit(n, parsed, wantPages));

  return {
    tree,
    stats: {
      nodes: countNodes(roots),
      leaves: countLeaves(roots),
      depth: roots.length ? maxDepth(roots, 1) : 0,
      headings: parsed.headings.length,
      substantive_lines: parsed.substantiveCount,
      total_lines: parsed.totalLines,
      body_start: parsed.bodyStart,
      domain_end: domainEnd,
      page_markers: parsed.pageMarkers.length,
      page_pattern: parsed.pagePattern,
    },
  };
}

module.exports = { buildSkeleton, chunkRange, OVERVIEW_SUFFIX, PART_SUFFIX, PREAMBLE_HEADING };
