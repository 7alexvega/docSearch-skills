'use strict';

const { slugOrLine, dedupe } = require('./slug');
const paths = require('./paths');

// ---------------------------------------------------------------------------
// The single implementation of every tree invariant.
//
// Ingestion, modify, sync, rebuild-summary, doctor, and CI all call this. There
// is deliberately no second copy of these rules in prose, in a hook, or in a
// skill file — a rule stated twice is a rule that drifts.
//
// This re-derives what it checks rather than trusting the builder: node_ids are
// recomputed from headings, coverage is recomputed from the source. A validator
// that shared the builder's reasoning would agree with its bugs.
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  err(code, message, extra) {
    this.errors.push(Object.assign({ code, message }, extra || {}));
  }
  warn(code, message, extra) {
    this.warnings.push(Object.assign({ code, message }, extra || {}));
  }
  get ok() {
    return this.errors.length === 0;
  }
}

function walk(nodes, fn, ancestors) {
  const chain = ancestors || [];
  for (const node of nodes || []) {
    fn(node, chain);
    walk(node.children, fn, chain.concat([node]));
  }
}

// -- structural -------------------------------------------------------------

function validateStructure(tree, options, report) {
  const opts = options || {};
  const wantPages = !!opts.wantPages;

  if (!isNonEmptyString(tree.file)) report.err('root_file_missing', 'Root is missing a `file` string.');
  if (!isNonEmptyString(tree.doc_type)) report.err('root_doc_type_missing', 'Root is missing a `doc_type` string.');
  if (!('root_summary' in tree)) report.err('root_summary_missing', 'Root has no `root_summary` field.');
  if (!Array.isArray(tree.children)) {
    report.err('root_children_missing', 'Root has no `children` array.');
    return report;
  }

  const fp = tree.source_fingerprint;
  if (!fp || typeof fp !== 'object') {
    report.err('fingerprint_missing', 'Root is missing `source_fingerprint`.');
  } else {
    if (!isInt(fp.line_count) || fp.line_count < 1) {
      report.err('fingerprint_line_count', 'source_fingerprint.line_count must be a positive integer.');
    }
    if (!HEX64.test(String(fp.sha256 || ''))) {
      report.err('fingerprint_sha256', 'source_fingerprint.sha256 must be a 64-character hex digest.');
    }
  }

  if (wantPages && !('page_range' in tree)) {
    report.err('root_page_range_missing', 'page_numbers_in_citations is enabled but the root has no `page_range`.');
  }
  if (!wantPages && 'page_range' in tree) {
    report.err('root_page_range_unexpected', 'page_numbers_in_citations is disabled but the root carries a `page_range`.');
  }

  const seenIds = new Map();
  const lineCount = fp && isInt(fp.line_count) ? fp.line_count : Infinity;

  walk(tree.children, (node, ancestors) => {
    const where = { node_id: node.node_id || null, heading: node.heading || null };

    if (!isNonEmptyString(node.heading)) report.err('heading_missing', 'Node has no `heading` string.', where);
    if (!isInt(node.level) || node.level < 1) report.err('level_invalid', 'Node `level` must be an integer >= 1.', where);
    if (!isNonEmptyString(node.node_id)) report.err('node_id_missing', 'Node has no `node_id` string.', where);
    if (!('summary' in node)) report.err('summary_field_missing', 'Node has no `summary` field.', where);
    if ('summary' in node && node.summary !== null && typeof node.summary !== 'string') {
      report.err('summary_type', 'Node `summary` must be a string or null.', where);
    }

    if (!Array.isArray(node.children)) {
      report.err('children_missing', 'Node has no `children` array. Every node must have one; leaves use [].', where);
      return;
    }

    const isLeaf = node.children.length === 0;
    if (isLeaf && !node.content_ref) {
      report.err('leaf_without_content_ref', 'Leaf node has no `content_ref`.', where);
    }
    if (!isLeaf && node.content_ref) {
      report.err('non_leaf_with_content_ref', 'Non-leaf node carries a `content_ref`; only leaves may.', where);
    }

    if (node.content_ref) {
      const lines = node.content_ref.lines;
      if (!Array.isArray(lines) || lines.length !== 2 || !isInt(lines[0]) || !isInt(lines[1])) {
        report.err('content_ref_shape', 'content_ref.lines must be a [start, end] pair of integers.', where);
      } else {
        if (lines[0] < 1) report.err('content_ref_start', 'content_ref start line must be >= 1.', Object.assign({ lines }, where));
        if (lines[1] < lines[0]) report.err('content_ref_order', 'content_ref end line precedes its start line.', Object.assign({ lines }, where));
        if (lines[1] > lineCount) {
          report.err('content_ref_out_of_bounds', `content_ref end line ${lines[1]} exceeds the source's ${lineCount} lines.`, Object.assign({ lines }, where));
        }
      }
    }

    if (wantPages) {
      if (!('page_range' in node)) {
        report.err('page_range_missing', 'page_numbers_in_citations is enabled but this node has no `page_range`.', where);
      } else if (node.page_range !== null) {
        const pr = node.page_range;
        if (!Array.isArray(pr) || pr.length !== 2 || !isInt(pr[0]) || !isInt(pr[1]) || pr[1] < pr[0]) {
          report.err('page_range_shape', 'page_range must be a [start, end] pair of integers with start <= end.', where);
        }
      }
    } else if ('page_range' in node) {
      report.err('page_range_unexpected', 'page_numbers_in_citations is disabled but this node carries a `page_range`.', where);
    }

    if ('cross_refs' in node) {
      const refs = node.cross_refs;
      if (!Array.isArray(refs)) {
        report.err('cross_refs_type', '`cross_refs` must be an array when present.', where);
      } else if (refs.length === 0) {
        report.err('cross_refs_empty', '`cross_refs` is an empty array; the field must be absent when there are none.', where);
      } else {
        refs.forEach((ref, i) => {
          const rw = Object.assign({ index: i }, where);
          if (!ref || typeof ref !== 'object') { report.err('cross_ref_shape', 'Cross-reference entry is not an object.', rw); return; }
          if (ref.type !== 'intra' && ref.type !== 'inter') report.err('cross_ref_type', "Cross-reference `type` must be 'intra' or 'inter'.", rw);
          if (!isNonEmptyString(ref.raw)) report.err('cross_ref_raw', 'Cross-reference `raw` must be a non-empty string.', rw);
          if (!isNonEmptyString(ref.target)) report.err('cross_ref_target', 'Cross-reference `target` must be a non-empty string.', rw);
          if (!('resolved_node' in ref)) report.err('cross_ref_resolved_node_missing', 'Cross-reference must always carry `resolved_node`, null when unresolved.', rw);
          if (!('resolved_file' in ref)) report.err('cross_ref_resolved_file_missing', 'Cross-reference must always carry `resolved_file`, null when unresolved.', rw);
          if ('resolved_node' in ref && ref.resolved_node !== null && !isNonEmptyString(ref.resolved_node)) report.err('cross_ref_resolved_node_type', '`resolved_node` must be a string or null.', rw);
          if ('resolved_file' in ref && ref.resolved_file !== null && !isNonEmptyString(ref.resolved_file)) report.err('cross_ref_resolved_file_type', '`resolved_file` must be a string or null.', rw);
        });
      }
    }

    if (isNonEmptyString(node.node_id)) {
      if (seenIds.has(node.node_id)) {
        report.err('node_id_duplicate', `Duplicate node_id \`${node.node_id}\`.`, where);
      } else {
        seenIds.set(node.node_id, true);
      }
    }
  });

  validateNodeIdChains(tree, report);
  return report;
}

// Recomputes every node_id from the headings actually present and compares.
// This catches a node moved between parents without its id being rebuilt, which
// silently breaks cross-reference resolution.
function validateNodeIdChains(tree, report) {
  if (!isNonEmptyString(tree.file)) return;
  const stem = paths.treeStem(tree.file);

  function recurse(nodes, ancestorSlugs) {
    const slugs = dedupe((nodes || []).map(n => {
      const line = n.content_ref && n.content_ref.lines ? n.content_ref.lines[0] : 0;
      return slugOrLine(n.heading, line);
    }));
    (nodes || []).forEach((node, i) => {
      const expected = [stem].concat(ancestorSlugs, [slugs[i]]).join('_');
      if (isNonEmptyString(node.node_id) && node.node_id !== expected) {
        report.err('node_id_mismatch',
          `node_id \`${node.node_id}\` does not match the id its heading path produces (\`${expected}\`).`,
          { node_id: node.node_id, heading: node.heading, expected });
      }
      recurse(node.children, ancestorSlugs.concat([slugs[i]]));
    });
  }
  recurse(tree.children, []);
}

// -- coverage ---------------------------------------------------------------

// Requires the parsed source. Confirms the leaves partition the document's
// substantive content, with the single documented exception for the heading
// line of a non-leaf node.
function validateCoverage(tree, parsed, report) {
  const owner = new Map();
  const nonLeafHeadingLines = new Set();

  walk(tree.children, (node) => {
    const isLeaf = Array.isArray(node.children) && node.children.length === 0;
    if (!isLeaf) {
      if (node.content_ref && node.content_ref.lines) nonLeafHeadingLines.add(node.content_ref.lines[0]);
      return;
    }
    if (!node.content_ref || !Array.isArray(node.content_ref.lines)) return;
    const [start, end] = node.content_ref.lines;
    for (let n = start; n <= end; n++) {
      if (owner.has(n)) {
        report.err('overlapping_leaf_ranges',
          `Line ${n} is claimed by both \`${owner.get(n)}\` and \`${node.node_id}\`.`,
          { line: n, node_id: node.node_id, other: owner.get(n) });
      } else {
        owner.set(n, node.node_id);
      }
    }
  });

  // A non-leaf's heading line is represented by its `heading` field rather than
  // by a leaf, so an uncovered heading line is legitimate. Every other
  // uncovered substantive line is a defect. Exempted lines are counted and
  // reported rather than silently skipped, so the exemption stays visible.
  const uncovered = [];
  const exempt = [];
  const parsedHeadingLines = new Set(parsed.headings.map(h => h.line));
  for (let n = parsed.bodyStart; n <= parsed.lastSubstantiveLine; n++) {
    if (!parsed.substantive[n]) continue;
    if (owner.has(n)) continue;
    if (parsedHeadingLines.has(n)) { exempt.push(n); continue; }
    uncovered.push(n);
  }

  if (uncovered.length) {
    report.err('uncovered_substantive_lines',
      `${uncovered.length} substantive line(s) belong to no leaf: ${summarizeLines(uncovered)}.`,
      { lines: uncovered.slice(0, 50), count: uncovered.length });
  }

  // Structural heading lines are exempt from coverage by design (see above),
  // so they must not count against the ratio either — otherwise any document
  // with nested sections would score below 100% with zero actual defects.
  const coverable = countCoverable(parsed) - exempt.length;
  const covered = countCovered(owner, parsed);
  return {
    coverable_lines: coverable,
    covered_lines: covered,
    coverage_ratio: coverable === 0 ? 1 : Number((covered / coverable).toFixed(4)),
    uncovered_count: uncovered.length,
    structural_heading_lines: exempt.length,
  };
}

function countCoverable(parsed) {
  let n = 0;
  for (let i = parsed.bodyStart; i <= parsed.lastSubstantiveLine; i++) if (parsed.substantive[i]) n++;
  return n;
}

function countCovered(owner, parsed) {
  let n = 0;
  for (let i = parsed.bodyStart; i <= parsed.lastSubstantiveLine; i++) {
    if (parsed.substantive[i] && owner.has(i)) n++;
  }
  return n;
}

function summarizeLines(lines) {
  const shown = lines.slice(0, 10).join(', ');
  return lines.length > 10 ? `${shown}, …` : shown;
}

// -- entry point ------------------------------------------------------------

/**
 * @param {object} tree     the tree index to check
 * @param {object} opts
 * @param {boolean} opts.wantPages   whether page_range must be present
 * @param {object}  [opts.parsed]    parsed source; enables coverage checks
 * @param {object}  [opts.fingerprint] freshly computed source fingerprint
 */
function validateTree(tree, opts) {
  const options = opts || {};
  const report = new Report();

  validateStructure(tree, options, report);

  let coverage = null;
  if (options.parsed) {
    coverage = validateCoverage(tree, options.parsed, report);
  }

  if (options.fingerprint && tree.source_fingerprint) {
    const a = tree.source_fingerprint;
    const b = options.fingerprint;
    if (a.line_count !== b.line_count || a.sha256 !== b.sha256) {
      report.err('fingerprint_mismatch',
        'The tree\'s source_fingerprint does not match the source file on disk; the tree is stale.',
        { recorded: a, actual: b });
    }
  }

  return {
    ok: report.ok,
    file: tree.file || null,
    errors: report.errors,
    warnings: report.warnings,
    coverage,
  };
}

// -- document summary index --------------------------------------------------

/**
 * Validates the routing index against the configured hierarchy.
 *
 * The hierarchy is a configured list, not a fixed shape — homogeneous vaults
 * legitimately omit doc_group/doc_type as levels — so every check here walks
 * `hierarchy_fields` generically rather than assuming any field sits anywhere.
 *
 * @param {object} index
 * @param {object} opts
 * @param {string[]} opts.hierarchyFields
 * @param {string[]} [opts.baseSchema]
 * @param {Set<string>} [opts.availableTrees] tree filenames present on disk
 */
function validateIndex(index, opts) {
  const options = opts || {};
  const hierarchy = options.hierarchyFields || [];
  const baseSchema = options.baseSchema || [];
  const report = new Report();

  if (!index || typeof index !== 'object') {
    report.err('index_not_object', 'The routing index is not a JSON object.');
    return { ok: false, errors: report.errors, warnings: report.warnings, leaves: 0 };
  }
  if (index.type !== 'root') report.err('index_root_type', "The routing index's top node must have type 'root'.");
  if ('field' in index || 'value' in index) report.err('index_root_fields', 'The root node must not carry `field` or `value`.');
  if (!Array.isArray(index.children)) {
    report.err('index_root_children', 'The root node has no `children` array.');
    return { ok: false, errors: report.errors, warnings: report.warnings, leaves: 0 };
  }

  let leafCount = 0;
  const seenFiles = new Map();

  (function walk(node, depth, trail) {
    for (const child of node.children || []) {
      const where = { path: trail.concat([`${child.field || '?'}=${child.value === undefined ? '?' : child.value}`]).join(' > ') };

      if (child.type === 'leaf') {
        leafCount++;
        const leafWhere = Object.assign({ file: child.file || null }, where);

        if (depth + 1 !== hierarchy.length) {
          report.err('leaf_depth_mismatch',
            `Leaf for \`${child.file}\` sits at depth ${depth + 1} but the configured hierarchy has ${hierarchy.length} level(s).`, leafWhere);
        }
        if ('children' in child) {
          report.err('leaf_has_children', `Leaf for \`${child.file}\` carries a \`children\` key; leaves must not.`, leafWhere);
        }
        for (const field of baseSchema) {
          if (!(field in child)) report.err('leaf_missing_base_field', `Leaf for \`${child.file}\` is missing required field \`${field}\`.`, leafWhere);
        }
        if (!isNonEmptyString(child.summary)) {
          report.err('leaf_summary_missing', `Leaf for \`${child.file}\` has no prose summary.`, leafWhere);
        }
        if (!isNonEmptyString(child.tree_index)) {
          report.err('leaf_tree_index_missing', `Leaf for \`${child.file}\` has no \`tree_index\`.`, leafWhere);
        } else if (child.tree_index.includes('/') || child.tree_index.includes('\\')) {
          report.err('leaf_tree_index_path', `Leaf \`tree_index\` must be a bare filename, not a path (got \`${child.tree_index}\`).`, leafWhere);
        } else if (options.availableTrees && !options.availableTrees.has(child.tree_index)) {
          report.err('leaf_tree_index_dangling', `Leaf for \`${child.file}\` points at \`${child.tree_index}\`, which is not present in the trees directory.`, leafWhere);
        }
        if (isNonEmptyString(child.file)) {
          if (seenFiles.has(child.file)) report.err('leaf_duplicate_file', `Two leaves both claim \`${child.file}\`.`, leafWhere);
          else seenFiles.set(child.file, true);
        }
        continue;
      }

      if (child.type !== 'intermediate') {
        report.err('node_type_invalid', `Node type must be 'intermediate' or 'leaf' (got ${JSON.stringify(child.type)}).`, where);
        continue;
      }
      if ('tree_index' in child) {
        report.err('intermediate_has_tree_index', 'Intermediate nodes must not carry `tree_index`; only leaves may.', where);
      }
      const expectedField = hierarchy[depth];
      if (expectedField && child.field !== expectedField) {
        report.err('hierarchy_field_mismatch',
          `Node at depth ${depth} has field \`${child.field}\` but the configured hierarchy expects \`${expectedField}\`.`, where);
      }
      if (!Array.isArray(child.children) || child.children.length === 0) {
        report.err('intermediate_empty', `Intermediate node \`${child.field}=${child.value}\` has no children; it should have been pruned.`, where);
        continue;
      }
      walk(child, depth + 1, trail.concat([`${child.field}=${child.value}`]));
    }
  })(index, 0, []);

  return { ok: report.ok, errors: report.errors, warnings: report.warnings, leaves: leafCount };
}

module.exports = { validateTree, validateIndex, validateStructure, validateCoverage, Report };
