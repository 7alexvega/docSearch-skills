'use strict';

// ---------------------------------------------------------------------------
// Deterministic source classification.
//
// The redesign plan described `navigation_only` as "meaningful routing links
// but no content that can answer a query directly" — which is a judgment call
// wearing a rule's clothes. Every rule here is instead expressed in counts the
// parser already produces, so two runs on the same file always agree and no
// model participates.
//
// Where a rule needs a threshold, the threshold is config-visible rather than
// buried, because the right value genuinely differs between a docs site and a
// folder of filings.
// ---------------------------------------------------------------------------

const REDIRECT_PHRASE = /\b(has\s+moved|have\s+moved|moved\s+to|redirect(?:ed|s|ing)?|see\s+instead|now\s+lives|now\s+located|relocated|superseded\s+by|replaced\s+by|this\s+page\s+is\s+now)\b/i;

const CLASSIFICATIONS = ['substantive', 'redirect', 'placeholder', 'navigation_only', 'unsupported'];

const DEFAULTS = {
  placeholder_word_threshold: 20,
  redirect_max_prose_words: 40,
  navigation_min_links: 5,
  navigation_max_non_link_words: 30,
};

function thresholds(config) {
  const q = (config && config.ingestion_quality) || {};
  return {
    placeholder_word_threshold: num(q.placeholder_word_threshold, DEFAULTS.placeholder_word_threshold),
    redirect_max_prose_words: num(q.redirect_max_prose_words, DEFAULTS.redirect_max_prose_words),
    navigation_min_links: num(q.navigation_min_links, DEFAULTS.navigation_min_links),
    navigation_max_non_link_words: num(q.navigation_max_non_link_words, DEFAULTS.navigation_max_non_link_words),
  };
}

function num(v, fallback) {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
}

// A link is "local" when it points at another Markdown file in the vault
// rather than off to the web or to an anchor within this page.
function isLocalMarkdownLink(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // http:, mailto:, etc.
  if (target.startsWith('#')) return false;
  const withoutAnchor = target.split('#')[0];
  return /\.md$/i.test(withoutAnchor);
}

// Resolves a local link against the linking document's own directory, giving a
// path relative to the ingestion root — the same form `file` takes everywhere.
function resolveLocalTarget(relativePath, target) {
  const withoutAnchor = target.split('#')[0];
  const baseDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
  const joined = withoutAnchor.startsWith('/')
    ? withoutAnchor.slice(1)
    : (baseDir ? baseDir + '/' + withoutAnchor : withoutAnchor);

  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * @param {object} parsed        markdown.parse output
 * @param {string} relativePath  source path relative to the ingestion root
 * @param {object} config        loaded config
 * @returns {{classification, reason, metrics, alias_target}}
 */
function classify(parsed, relativePath, config) {
  const t = thresholds(config);

  const localLinks = parsed.links
    .filter(l => isLocalMarkdownLink(l.target))
    .map(l => ({ raw: l.target, resolved: resolveLocalTarget(relativePath, l.target), line: l.line }));

  const metrics = {
    headings: parsed.headings.length,
    substantive_lines: parsed.substantiveCount,
    prose_words: parsed.proseWords,
    non_link_words: parsed.nonLinkWords,
    code_blocks: parsed.codeBlockCount,
    links: parsed.links.length,
    local_markdown_links: localLinks.length,
  };

  const proseText = collectProse(parsed);

  // -- empty ---------------------------------------------------------------
  if (parsed.substantiveCount === 0) {
    return result('placeholder', 'The file contains no substantive lines.', metrics, null);
  }

  // -- redirect ------------------------------------------------------------
  // Ordered before placeholder: a redirect page is also short, but it carries a
  // target worth preserving as an alias, where a placeholder carries nothing.
  const redirectConditions = {
    at_most_one_heading: parsed.headings.length <= 1,
    no_code_blocks: parsed.codeBlockCount === 0,
    has_local_markdown_target: localLinks.length >= 1,
    has_redirect_phrase: REDIRECT_PHRASE.test(proseText),
    no_independent_explanation: parsed.proseWords <= t.redirect_max_prose_words,
  };
  if (Object.values(redirectConditions).every(Boolean)) {
    return result(
      'redirect',
      `Single-heading page whose only content is a redirect statement pointing at ${localLinks[0].resolved}.`,
      metrics,
      localLinks[0].resolved,
      { conditions: redirectConditions }
    );
  }

  // -- placeholder ---------------------------------------------------------
  if (parsed.proseWords < t.placeholder_word_threshold && parsed.codeBlockCount === 0) {
    return result(
      'placeholder',
      `Only ${parsed.proseWords} words of prose and no code or configuration (threshold ${t.placeholder_word_threshold}).`,
      metrics,
      null
    );
  }

  // -- navigation only -----------------------------------------------------
  if (
    parsed.links.length >= t.navigation_min_links &&
    parsed.nonLinkWords <= t.navigation_max_non_link_words &&
    parsed.codeBlockCount === 0
  ) {
    return result(
      'navigation_only',
      `${parsed.links.length} links with only ${parsed.nonLinkWords} words outside link text (thresholds ${t.navigation_min_links} / ${t.navigation_max_non_link_words}).`,
      metrics,
      null,
      { links: localLinks.map(l => l.resolved) }
    );
  }

  return result('substantive', 'Contains prose, code, or configuration beyond navigation and boilerplate.', metrics, null);
}

function collectProse(parsed) {
  const headingLines = new Set(parsed.headings.map(h => h.line));
  const underlineLines = new Set(parsed.headings.filter(h => h.underlineLine).map(h => h.underlineLine));
  const out = [];
  for (let n = parsed.bodyStart; n <= parsed.totalLines; n++) {
    if (!parsed.substantive[n] || parsed.inCode[n]) continue;
    if (headingLines.has(n) || underlineLines.has(n)) continue;
    out.push(parsed.lines[n - 1]);
  }
  return out.join('\n');
}

function result(classification, reason, metrics, aliasTarget, extra) {
  return Object.assign({
    classification,
    reason,
    metrics,
    alias_target: aliasTarget,
    indexed: classification === 'substantive',
  }, extra || {});
}

module.exports = { classify, CLASSIFICATIONS, DEFAULTS, isLocalMarkdownLink, resolveLocalTarget };
