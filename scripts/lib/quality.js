'use strict';

const similarity = require('./similarity');

// ---------------------------------------------------------------------------
// Summary quality rules.
//
// Generation is model-driven; acceptance is not. Every rule below is a
// mechanical check with a stable reason string, because those reasons are fed
// straight back into the retry prompt — a rejection the model cannot act on is
// just an expensive way to fail twice.
// ---------------------------------------------------------------------------

const BANNED_PATTERNS = [
  { code: 'generic_documentation_covering', re: /^\s*documentation\s+(covering|for|about)\b/i,
    hint: 'Opens with "Documentation covering…", which says nothing a heading did not.' },
  { code: 'generic_covers_config_usage', re: /\bcovers\s+configuration,\s*usage,?\s*and\s+operational\s+guidance\b/i,
    hint: 'Uses the boilerplate "Covers configuration, usage, and operational guidance."' },
  { code: 'generic_this_section', re: /^\s*this\s+(section|page|chapter|part)\s+(discusses|describes|covers|explains|contains|provides)\b/i,
    hint: 'Opens with "This section discusses…" instead of stating what is in it.' },
  { code: 'generic_this_document', re: /^\s*this\s+document\s+(contains|provides|covers|describes)\s+information\b/i,
    hint: 'Opens with "This document contains information about…", which carries no content.' },
  { code: 'generic_information_about', re: /^\s*information\s+about\b/i,
    hint: 'Opens with "Information about…", which carries no content.' },
  { code: 'generic_overview_of', re: /^\s*(an?\s+)?overview\s+of\s+the\s+\w+\s+section\s*\.?\s*$/i,
    hint: 'Is only "an overview of the X section" with no specifics.' },
  { code: 'redirect_language', re: /^\s*redirect(ing|s|ed)?\b/i,
    hint: 'Reads as a redirect notice rather than a description of content.' },
];

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function normalizeForComparison(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Checks one summary in isolation.
 *
 * @param {object} opts
 * @param {string} opts.summary
 * @param {string} opts.heading     the node's own heading (or document title for a root)
 * @param {boolean} opts.isRoot
 * @param {object} opts.limits      resolved ingestion_quality values
 */
function checkSummary(opts) {
  const { summary, heading, isRoot, limits } = opts;
  const reasons = [];

  if (summary === null || summary === undefined || String(summary).trim() === '') {
    return [{ code: 'summary_missing', message: 'No summary was produced for this node.' }];
  }

  const text = String(summary).trim();
  const wordCount = words(text).length;
  const min = isRoot ? limits.root_summary_min_words : limits.node_summary_min_words;
  const max = isRoot ? limits.root_summary_max_words : limits.node_summary_max_words;

  if (wordCount < min) {
    reasons.push({ code: 'too_short', message: `Summary is ${wordCount} words; the minimum is ${min}. Add the specific subjects, operations, or values the section actually contains.` });
  }
  if (wordCount > max) {
    reasons.push({ code: 'too_long', message: `Summary is ${wordCount} words; the maximum is ${max}. Keep the concrete detail and drop the framing.` });
  }

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.re.test(text)) {
      reasons.push({ code: pattern.code, message: `${pattern.hint} Describe what a reader would retrieve from this content instead.` });
    }
  }

  // A summary that merely restates its heading tells the navigator nothing it
  // did not already have.
  const normSummary = normalizeForComparison(text);
  const normHeading = normalizeForComparison(heading);
  if (normHeading && normSummary === normHeading) {
    reasons.push({ code: 'repeats_heading', message: `Summary repeats the heading "${heading}" verbatim. It must add information the heading does not already convey.` });
  } else if (normHeading) {
    const headingTokens = similarity.tokenSet(heading);
    const summaryTokens = similarity.tokenSet(text);
    let novel = 0;
    for (const t of summaryTokens) if (!headingTokens.has(t)) novel++;
    if (novel < 3) {
      reasons.push({ code: 'adds_nothing_to_heading', message: `Summary contributes only ${novel} content word(s) beyond the heading "${heading}". Name concrete entities, operations, settings, or figures from the content.` });
    }
  }

  return reasons;
}

/**
 * Checks a whole document's summaries: each in isolation, plus sibling
 * distinctness within each parent.
 *
 * @param {object} tree     a tree with summaries filled in
 * @param {object} limits   resolved ingestion_quality values
 */
function checkTree(tree, limits) {
  const findings = [];

  const rootReasons = checkSummary({
    summary: tree.root_summary,
    heading: tree.file || '',
    isRoot: true,
    limits,
  });
  for (const r of rootReasons) findings.push(Object.assign({ node_id: null, scope: 'root' }, r));

  (function walk(nodes) {
    for (const node of nodes || []) {
      const reasons = checkSummary({
        summary: node.summary,
        heading: node.heading,
        isRoot: false,
        limits,
      });
      for (const r of reasons) findings.push(Object.assign({ node_id: node.node_id, heading: node.heading, scope: 'node' }, r));
      walk(node.children);
    }
  })(tree.children);

  // Sibling distinctness, checked per parent group.
  (function siblings(nodes) {
    const group = (nodes || []).filter(n => typeof n.summary === 'string' && n.summary.trim() !== '');
    if (group.length > 1) {
      const pairs = similarity.findSimilarPairs(
        group.map(n => ({ node_id: n.node_id, heading: n.heading, text: n.summary })),
        limits.sibling_summary_similarity_max
      );
      for (const p of pairs) {
        findings.push({
          scope: 'siblings',
          code: 'sibling_summaries_too_similar',
          node_id: p.b.node_id,
          heading: p.b.heading,
          message: `Summary is ${Math.round(p.score * 100)}% similar to sibling "${p.a.heading}" (limit ${Math.round(limits.sibling_summary_similarity_max * 100)}%). Say what distinguishes this section from that one.`,
          other_node_id: p.a.node_id,
          score: p.score,
        });
      }
    }
    for (const n of nodes || []) siblings(n.children);
  })(tree.children);

  return findings;
}

/**
 * Cross-document check: root summaries within one batch must be distinguishable
 * from each other, or the routing layer cannot tell the documents apart.
 */
function checkRootDistinctness(documents, limits) {
  const usable = documents.filter(d => typeof d.root_summary === 'string' && d.root_summary.trim() !== '');
  const pairs = similarity.findSimilarPairs(
    usable.map(d => ({ file: d.file, text: d.root_summary })),
    limits.root_summary_similarity_max
  );
  return pairs.map(p => ({
    scope: 'roots',
    code: 'root_summaries_too_similar',
    file: p.b.file,
    other_file: p.a.file,
    score: p.score,
    message: `Root summary is ${Math.round(p.score * 100)}% similar to that of "${p.a.file}" (limit ${Math.round(limits.root_summary_similarity_max * 100)}%). Name what this document covers that the other does not.`,
  }));
}

module.exports = { checkSummary, checkTree, checkRootDistinctness, BANNED_PATTERNS, words };
