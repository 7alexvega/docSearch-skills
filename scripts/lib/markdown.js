'use strict';

// ---------------------------------------------------------------------------
// Deterministic Markdown structure parser.
//
// This produces a source map only — headings, fences, page markers, and which
// lines carry substance. It never summarizes and never decides tree shape;
// that is tree.js's job working from this output.
//
// Line numbers are 1-indexed and inclusive everywhere, matching content_ref.
// Lines are split with the same expression the staleness fingerprint uses, so
// a tree's line numbers and its source_fingerprint.line_count always agree.
// ---------------------------------------------------------------------------

const PAGE_PATTERNS = [
  { name: 'html_comment', re: /<!--\s*page[:\s]+(\d+)\s*-->/i },
  { name: 'dashed', re: /^-{2,}\s*page\s+(\d+)\s*-{2,}$/i },
  { name: 'bare', re: /^\s*page\s+(\d+)\s*$/i },
  { name: 'form_feed', re: /\f/ },
];

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// A setext underline only promotes the line above it when that line is ordinary
// paragraph text. List items, block quotes, and table rows followed by `---`
// are far more likely to be real list/table syntax than a heading.
function isSetextCandidate(text) {
  if (text.trim() === '') return false;
  if (/^ {0,3}[-*+][ \t]/.test(text)) return false;
  if (/^ {0,3}\d+[.)][ \t]/.test(text)) return false;
  if (/^ {0,3}>/.test(text)) return false;
  if (text.includes('|')) return false;
  if (RE_SETEXT_UNDERLINE.test(text)) return false;
  if (RE_ATX.test(text)) return false;
  return true;
}

function detectFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return { start: 1, end: i + 1 };
  }
  // An unterminated opening `---` is a thematic break, not frontmatter.
  return null;
}

function parse(content) {
  const lines = content.split(/\r\n|\r|\n/);
  const totalLines = lines.length;

  const frontmatter = detectFrontmatter(lines);
  const bodyStart = frontmatter ? frontmatter.end + 1 : 1;

  const headings = [];
  const fences = [];
  const pageMarkers = [];
  const links = [];
  // 1-indexed; index 0 unused so lookups read naturally as substantive[lineNo].
  const substantive = new Array(totalLines + 1).fill(false);
  const inCode = new Array(totalLines + 1).fill(false);

  let pagePattern = null;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;

  for (let i = bodyStart - 1; i < totalLines; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (trimmed !== '') substantive[lineNo] = true;

    if (inFence) {
      inCode[lineNo] = true;
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false;
        fences.push({ start: fenceStart, end: lineNo });
      }
      continue;
    }

    const open = line.match(RE_FENCE_OPEN);
    if (open) {
      const char = open[1][0];
      const info = open[2] || '';
      // A backtick fence's info string may not contain a backtick; that rules
      // out inline code spans like ``a ` b`` being read as a fence opener.
      if (!(char === '`' && info.includes('`'))) {
        inFence = true;
        fenceChar = char;
        fenceLen = open[1].length;
        fenceStart = lineNo;
        inCode[lineNo] = true;
        continue;
      }
    }

    const atx = line.match(RE_ATX);
    if (atx) {
      const raw = atx[2] || '';
      // Strip an optional closing sequence of #s.
      const text = raw.replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      headings.push({ line: lineNo, level: atx[1].length, text, kind: 'atx' });
      continue;
    }

    const underline = line.match(RE_SETEXT_UNDERLINE);
    if (underline && lineNo - 1 >= bodyStart) {
      const prev = lines[i - 1];
      const prevIsHeading = headings.length && headings[headings.length - 1].line === lineNo - 1;
      if (!prevIsHeading && isSetextCandidate(prev) && !inCode[lineNo - 1]) {
        headings.push({
          line: lineNo - 1,
          level: underline[1][0] === '=' ? 1 : 2,
          text: prev.trim(),
          kind: 'setext',
          underlineLine: lineNo,
        });
        continue;
      }
    }

    for (const p of PAGE_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        pageMarkers.push({ line: lineNo, page: m[1] ? parseInt(m[1], 10) : pageMarkers.length + 1 });
        if (!pagePattern) pagePattern = p.name;
        break;
      }
    }

    RE_LINK.lastIndex = 0;
    let lm;
    while ((lm = RE_LINK.exec(line)) !== null) {
      links.push({ line: lineNo, text: lm[1], target: lm[2] });
    }
  }

  // An unterminated fence runs to EOF rather than silently swallowing nothing.
  if (inFence) fences.push({ start: fenceStart, end: totalLines, unterminated: true });

  const headingLines = new Set(headings.map(h => h.line));
  const underlineLines = new Set(headings.filter(h => h.underlineLine).map(h => h.underlineLine));

  let substantiveCount = 0;
  let lastSubstantiveLine = 0;
  let proseWords = 0;
  // Words remaining once link text is removed entirely. A page that is a list
  // of links has plenty of `proseWords` but almost no `nonLinkWords`, which is
  // what separates navigation from content mechanically.
  let nonLinkWords = 0;
  for (let n = bodyStart; n <= totalLines; n++) {
    if (!substantive[n]) continue;
    substantiveCount++;
    lastSubstantiveLine = n;
    if (inCode[n] || headingLines.has(n) || underlineLines.has(n)) continue;
    const stripped = lines[n - 1].replace(/<!--[\s\S]*?-->/g, ' ');
    const withLinkText = stripped.replace(RE_LINK, ' $1 ').trim();
    if (withLinkText !== '') {
      proseWords += withLinkText.split(/\s+/).filter(Boolean).length;
    }
    const withoutLinks = stripped
      .replace(RE_LINK, ' ')
      .replace(/^\s*[-*+]\s*/, ' ')
      .replace(/[|>#*_`]/g, ' ')
      .trim();
    if (withoutLinks !== '') {
      nonLinkWords += withoutLinks.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;
    }
  }

  return {
    lines,
    totalLines,
    frontmatter,
    bodyStart,
    headings,
    fences,
    pageMarkers,
    pagePattern,
    links,
    substantive,
    inCode,
    substantiveCount,
    lastSubstantiveLine,
    proseWords,
    nonLinkWords,
    codeBlockCount: fences.length,
  };
}

// Maps a line number to the page in effect at that line — the page of the last
// marker at or before it. Returns null when no marker precedes the line.
function pageAt(pageMarkers, line) {
  let page = null;
  for (const m of pageMarkers) {
    if (m.line <= line) page = m.page;
    else break;
  }
  return page;
}

function pageRangeFor(pageMarkers, startLine, endLine) {
  if (!pageMarkers.length) return null;
  const start = pageAt(pageMarkers, startLine);
  let end = pageAt(pageMarkers, endLine);
  if (start === null && end === null) return null;
  const s = start === null ? pageMarkers[0].page : start;
  const e = end === null ? s : end;
  return [s, Math.max(s, e)];
}

module.exports = { parse, pageAt, pageRangeFor, PAGE_PATTERNS };
