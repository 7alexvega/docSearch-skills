#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Fixture suite for the deterministic pipeline.
//
//   node test/run.js
//
// These fixtures are authored to be adversarial in the ways real corpora are:
// headings inside code fences, setext underlines, repeated sibling headings,
// content above the first heading, sections that must be split, and page
// markers. Every assertion below is a structural property the semantic stage
// is entitled to assume and therefore must never have to re-derive.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const markdown = require(path.join(ROOT, 'scripts', 'lib', 'markdown'));
const treeLib = require(path.join(ROOT, 'scripts', 'lib', 'tree'));
const validate = require(path.join(ROOT, 'scripts', 'lib', 'validate'));
const fingerprintLib = require(path.join(ROOT, 'scripts', 'lib', 'fingerprint'));
const pathsLib = require(path.join(ROOT, 'scripts', 'lib', 'paths'));

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push({ name, detail: detail || '' });
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function baseConfig(ingestionDir, overrides) {
  return Object.assign({
    schema_version: 2,
    vault: { type: 'homogeneous', ingestion_directory: ingestionDir, doc_type_path_mappings: {} },
    source: { docling_used: false, page_numbers_present: false, page_numbers_in_citations: false },
    doc_types: { base_schema: ['file', 'doc_type', 'doc_group', 'topics', 'date_added'], schemas: {} },
    chunking: { fallback_chunk_size_lines: 10, max_section_size_lines: 25 },
    doc_summary_index: { hierarchy_fields: ['doc_type'], max_nodes: 15 },
    query: { max_depth_per_branch: 4, max_nodes_per_query: 25, aggregation_multiplier: 3, output_format: 'json' },
  }, overrides || {});
}

function build(fixture, config) {
  const abs = path.join(FIXTURES, fixture);
  const content = fs.readFileSync(abs, 'utf8');
  const parsed = markdown.parse(content);
  const built = treeLib.buildSkeleton({
    parsed,
    relativePath: fixture,
    stem: pathsLib.treeStem(fixture),
    docType: 'technical_documentation',
    fingerprint: fingerprintLib.ofContent(content),
    config,
  });
  const validation = validate.validateTree(built.tree, {
    wantPages: !!config.source.page_numbers_in_citations,
    parsed,
  });
  return { parsed, built, validation, content };
}

function allNodes(nodes, out) {
  const acc = out || [];
  for (const n of nodes || []) { acc.push(n); allNodes(n.children, acc); }
  return acc;
}

// -- every fixture must be structurally valid and fully covered -------------

const config = baseConfig(FIXTURES);
const noPageFixtures = [
  'substantive.md', 'nested-introduction.md', 'headerless.md',
  'redirect.md', 'placeholder.md', 'edge-cases.md', 'oversized-section.md',
];

const results = {};
for (const f of noPageFixtures) {
  const r = build(f, config);
  results[f] = r;
  ok(`${f}: validates clean`, r.validation.ok,
    JSON.stringify(r.validation.errors.slice(0, 4), null, 2));
  ok(`${f}: 100% substantive coverage`,
    r.validation.coverage && r.validation.coverage.uncovered_count === 0,
    `uncovered=${r.validation.coverage && r.validation.coverage.uncovered_count}`);
  const ids = allNodes(r.built.tree.children).map(n => n.node_id);
  eq(`${f}: node_ids unique`, new Set(ids).size, ids.length);
  ok(`${f}: every summary starts null`,
    allNodes(r.built.tree.children).every(n => n.summary === null), 'a summary was pre-filled');
  ok(`${f}: leaves have content_ref, non-leaves do not`,
    allNodes(r.built.tree.children).every(n =>
      (n.children.length === 0) === Boolean(n.content_ref)), 'content_ref placement wrong');
  ok(`${f}: every node has children array`,
    allNodes(r.built.tree.children).every(n => Array.isArray(n.children)), 'missing children array');
}

// -- code fences and setext -------------------------------------------------

{
  const r = results['edge-cases.md'];
  const headings = r.parsed.headings.map(h => h.text);

  ok('edge-cases: fenced "# This Is Not A Heading" is not parsed as a heading',
    !headings.includes('This Is Not A Heading'), JSON.stringify(headings));
  ok('edge-cases: fenced "## Neither Is This" is not parsed as a heading',
    !headings.includes('Neither Is This'), JSON.stringify(headings));
  ok('edge-cases: tilde-fenced heading-like line is not parsed as a heading',
    !headings.includes('Tilde-fenced, also not a heading'), JSON.stringify(headings));

  const setextH1 = r.parsed.headings.find(h => h.text === 'Document Title Set With Setext');
  ok('edge-cases: setext H1 detected', Boolean(setextH1), JSON.stringify(headings));
  eq('edge-cases: setext H1 has level 1', setextH1 && setextH1.level, 1);

  const setextH2 = r.parsed.headings.find(h => h.text === 'Second Level Via Setext');
  ok('edge-cases: setext H2 detected', Boolean(setextH2), JSON.stringify(headings));
  eq('edge-cases: setext H2 has level 2', setextH2 && setextH2.level, 2);

  ok('edge-cases: closing hash sequence stripped from heading text',
    headings.includes('Trailing section'), JSON.stringify(headings));

  ok('edge-cases: inline double-backtick code does not open a fence',
    headings.includes('Inline code with backticks'), JSON.stringify(headings));

  const repeated = allNodes(r.built.tree.children).filter(n => n.heading === 'Repeated Heading');
  eq('edge-cases: both repeated headings became nodes', repeated.length, 2);
  ok('edge-cases: repeated sibling headings get distinct node_ids',
    repeated.length === 2 && repeated[0].node_id !== repeated[1].node_id,
    JSON.stringify(repeated.map(n => n.node_id)));
  ok('edge-cases: the second duplicate is suffixed',
    repeated.length === 2 && /-2$/.test(repeated[1].node_id),
    JSON.stringify(repeated.map(n => n.node_id)));
}

// -- parent with introductory content --------------------------------------

{
  const r = results['nested-introduction.md'];
  const top = r.built.tree.children[0];
  eq('nested-introduction: single top-level section', r.built.tree.children.length, 1);
  eq('nested-introduction: top-level heading', top.heading, 'Reverse Proxy Setup');
  eq('nested-introduction: overview leaf inserted first',
    top.children[0] && top.children[0].heading, 'Reverse Proxy Setup — Overview');
  ok('nested-introduction: overview leaf is a leaf',
    top.children[0] && top.children[0].children.length === 0 && Boolean(top.children[0].content_ref));
  eq('nested-introduction: overview plus two real sections', top.children.length, 3);
  ok('nested-introduction: parent lost its content_ref to the overview leaf', !top.content_ref);
  ok('nested-introduction: overview covers the intro prose, not the whole section',
    top.children[0].content_ref.lines[1] < top.children[1].content_ref.lines[0],
    JSON.stringify(top.children.map(c => c.content_ref && c.content_ref.lines)));
}

// -- headerless chunking ----------------------------------------------------

{
  const r = results['headerless.md'];
  const kids = r.built.tree.children;
  eq('headerless: no headings found', r.parsed.headings.length, 0);
  ok('headerless: split into multiple chunks', kids.length > 1, `got ${kids.length}`);
  ok('headerless: chunks are labelled sequentially',
    kids.every((c, i) => c.heading === `Chunk ${i + 1}`), JSON.stringify(kids.map(c => c.heading)));
  ok('headerless: every chunk is a leaf', kids.every(c => c.children.length === 0));
  ok('headerless: chunk ranges are contiguous and non-overlapping',
    kids.every((c, i) => i === 0 || c.content_ref.lines[0] === kids[i - 1].content_ref.lines[1] + 1),
    JSON.stringify(kids.map(c => c.content_ref.lines)));
  ok('headerless: no chunk exceeds the configured size',
    kids.every(c => c.content_ref.lines[1] - c.content_ref.lines[0] + 1 <= config.chunking.fallback_chunk_size_lines));
}

// -- oversized section splitting -------------------------------------------

{
  const r = results['oversized-section.md'];
  const table = allNodes(r.built.tree.children).find(n => n.heading === 'Complete error table');
  ok('oversized: the long section was split', table && table.children.length > 1,
    `children=${table && table.children.length}`);
  ok('oversized: parts are labelled sequentially',
    table && table.children.every((c, i) => c.heading === `Complete error table — Part ${i + 1}`),
    JSON.stringify(table && table.children.map(c => c.heading)));
  ok('oversized: split parent has no content_ref', table && !table.content_ref);
  ok('oversized: no part exceeds max_section_size_lines',
    table && table.children.every(c =>
      c.content_ref.lines[1] - c.content_ref.lines[0] + 1 <= config.chunking.max_section_size_lines),
    JSON.stringify(table && table.children.map(c => c.content_ref.lines)));
  const notes = allNodes(r.built.tree.children).find(n => n.heading === 'Notes');
  ok('oversized: the short sibling section was not split', notes && notes.children.length === 0);
}

// -- frontmatter ------------------------------------------------------------

{
  const r = results['substantive.md'];
  ok('substantive: frontmatter detected', Boolean(r.parsed.frontmatter));
  eq('substantive: body starts after frontmatter', r.parsed.bodyStart, r.parsed.frontmatter.end + 1);
  const firstLeaf = allNodes(r.built.tree.children).find(n => n.children.length === 0);
  ok('substantive: no leaf range reaches into the frontmatter',
    allNodes(r.built.tree.children)
      .filter(n => n.content_ref)
      .every(n => n.content_ref.lines[0] >= r.parsed.bodyStart),
    `bodyStart=${r.parsed.bodyStart}, first leaf=${JSON.stringify(firstLeaf && firstLeaf.content_ref)}`);
  ok('substantive: fenced bash block did not produce headings',
    !r.parsed.headings.some(h => h.text.startsWith('curl')), '');
}

// -- page ranges ------------------------------------------------------------

{
  const pagedConfig = baseConfig(FIXTURES, {
    source: { docling_used: true, page_numbers_present: true, page_numbers_in_citations: true },
  });
  const r = build('paged.md', pagedConfig);
  results['paged.md'] = r;
  ok('paged: validates clean', r.validation.ok, JSON.stringify(r.validation.errors.slice(0, 4), null, 2));
  eq('paged: three page markers found', r.parsed.pageMarkers.length, 3);
  eq('paged: marker pattern identified', r.parsed.pagePattern, 'html_comment');
  ok('paged: root carries a page_range', Array.isArray(r.built.tree.page_range));
  ok('paged: every node carries a page_range',
    allNodes(r.built.tree.children).every(n => 'page_range' in n));
  ok('paged: page ranges are ordered pairs',
    allNodes(r.built.tree.children).every(n =>
      n.page_range === null || (n.page_range[0] <= n.page_range[1])));
}

// -- page config mismatch is rejected, not guessed at ------------------------

{
  const pagedConfig = baseConfig(FIXTURES, {
    source: { docling_used: false, page_numbers_present: true, page_numbers_in_citations: true },
  });
  const r = build('substantive.md', pagedConfig);
  ok('page mismatch: a tree built with pages on but no markers fails validation',
    !r.validation.ok || r.built.tree.page_range === null,
    'expected page_range to be null or validation to fail');
}

// -- the validator independently rejects tampering --------------------------

{
  const r = results['substantive.md'];
  const clone = JSON.parse(JSON.stringify(r.built.tree));
  const nodes = allNodes(clone.children);

  const missingChildren = JSON.parse(JSON.stringify(clone));
  delete allNodes(missingChildren.children)[1].children;
  ok('validator: catches a node missing its children array',
    !validate.validateTree(missingChildren, { parsed: r.parsed }).ok);

  const badRef = JSON.parse(JSON.stringify(clone));
  const firstParent = allNodes(badRef.children).find(n => n.children.length > 0);
  firstParent.content_ref = { lines: [1, 2] };
  ok('validator: catches content_ref on a non-leaf',
    !validate.validateTree(badRef, { parsed: r.parsed }).ok);

  const dupIds = JSON.parse(JSON.stringify(clone));
  const dn = allNodes(dupIds.children);
  dn[1].node_id = dn[0].node_id;
  ok('validator: catches duplicate node_ids',
    !validate.validateTree(dupIds, { parsed: r.parsed }).ok);

  const renamed = JSON.parse(JSON.stringify(clone));
  allNodes(renamed.children)[0].node_id = 'totally_made_up_id';
  ok('validator: catches a node_id that does not match its heading path',
    !validate.validateTree(renamed, { parsed: r.parsed }).ok);

  const overlap = JSON.parse(JSON.stringify(clone));
  const leaves = allNodes(overlap.children).filter(n => n.children.length === 0);
  leaves[1].content_ref.lines[0] = leaves[0].content_ref.lines[0];
  ok('validator: catches overlapping leaf ranges',
    !validate.validateTree(overlap, { parsed: r.parsed }).ok);

  const gap = JSON.parse(JSON.stringify(clone));
  const gapLeaves = allNodes(gap.children).filter(n => n.children.length === 0);
  gapLeaves[0].content_ref.lines[1] = gapLeaves[0].content_ref.lines[0];
  ok('validator: catches uncovered substantive lines',
    !validate.validateTree(gap, { parsed: r.parsed }).ok);

  const emptyRefs = JSON.parse(JSON.stringify(clone));
  allNodes(emptyRefs.children)[0].cross_refs = [];
  ok('validator: catches an empty cross_refs array',
    !validate.validateTree(emptyRefs, { parsed: r.parsed }).ok);

  const badFp = JSON.parse(JSON.stringify(clone));
  badFp.source_fingerprint.sha256 = 'nope';
  ok('validator: catches a malformed fingerprint',
    !validate.validateTree(badFp, { parsed: r.parsed }).ok);

  const stale = JSON.parse(JSON.stringify(clone));
  ok('validator: catches a stale fingerprint against the real source',
    !validate.validateTree(stale, {
      parsed: r.parsed,
      fingerprint: { line_count: 999, sha256: 'a'.repeat(64) },
    }).ok);

  ok('validator: the untampered tree still passes',
    validate.validateTree(clone, { parsed: r.parsed }).ok);
  eq('validator: sanity — the clone had nodes to tamper with', nodes.length > 3, true);
}

// -- classification ---------------------------------------------------------

{
  const classifyLib = require(path.join(ROOT, 'scripts', 'lib', 'classify'));

  function classifyFixture(fixture) {
    const content = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
    return classifyLib.classify(markdown.parse(content), fixture, config);
  }

  const expected = {
    'substantive.md': 'substantive',
    'nested-introduction.md': 'substantive',
    'headerless.md': 'substantive',
    'edge-cases.md': 'substantive',
    'oversized-section.md': 'substantive',
    'paged.md': 'substantive',
    'redirect.md': 'redirect',
    'placeholder.md': 'placeholder',
    'navigation.md': 'navigation_only',
  };
  for (const [fixture, want] of Object.entries(expected)) {
    const got = classifyFixture(fixture);
    eq(`classify: ${fixture} -> ${want}`, got.classification, want);
  }

  const redirect = classifyFixture('redirect.md');
  eq('classify: redirect resolves its alias target', redirect.alias_target, 'substantive.md');
  eq('classify: redirect is not indexed as its own document', redirect.indexed, false);

  eq('classify: placeholder is not indexed', classifyFixture('placeholder.md').indexed, false);
  eq('classify: navigation page is not indexed', classifyFixture('navigation.md').indexed, false);
  eq('classify: substantive page is indexed', classifyFixture('substantive.md').indexed, true);

  // A page with the same link density but real prose must NOT be swept up as
  // navigation — this is the failure mode that would silently drop content.
  const denseLinks = [
    '# Choosing a Retention Tier',
    '',
    'Standard retrieval completes within twelve hours and is billed at the base',
    'rate. Expedited retrieval completes in roughly five minutes but costs about',
    'ten times as much and is rate limited per account, so it is best reserved',
    'for incident response rather than routine restores. Objects under legal',
    'hold are exempt from every lifecycle transition regardless of tier.',
    '',
    '- [Installing the Gateway](./substantive.md)',
    '- [Reverse Proxy Setup](./nested-introduction.md)',
    '- [Error Codes](./oversized-section.md)',
    '- [Retention Policy](./headerless.md)',
    '- [Annual Review](./paged.md)',
    '- [Edge Cases](./edge-cases.md)',
  ].join('\n');
  const dense = classifyLib.classify(markdown.parse(denseLinks), 'dense.md', config);
  eq('classify: link-heavy page with real prose stays substantive', dense.classification, 'substantive');

  // Local-vs-external link discrimination.
  ok('classify: http links are not local markdown targets',
    !classifyLib.isLocalMarkdownLink('https://example.com/a.md'));
  ok('classify: anchors are not local markdown targets',
    !classifyLib.isLocalMarkdownLink('#section'));
  ok('classify: relative .md links are local targets',
    classifyLib.isLocalMarkdownLink('./other.md'));
  eq('classify: link targets resolve relative to the linking document',
    classifyLib.resolveLocalTarget('guides/setup/install.md', '../overview.md'),
    'guides/overview.md');
  eq('classify: anchors are stripped when resolving a target',
    classifyLib.resolveLocalTarget('a/b.md', './c.md#section'), 'a/c.md');
}

// -- determinism ------------------------------------------------------------

{
  const a = build('substantive.md', config);
  const b = build('substantive.md', config);
  eq('determinism: two builds of the same source are byte-identical',
    JSON.stringify(a.built.tree), JSON.stringify(b.built.tree));
}

// -- summary quality rules --------------------------------------------------

{
  const quality = require(path.join(ROOT, 'scripts', 'lib', 'quality'));
  const similarity = require(path.join(ROOT, 'scripts', 'lib', 'similarity'));

  const limits = {
    node_summary_min_words: 15, node_summary_max_words: 60,
    root_summary_min_words: 30, root_summary_max_words: 100,
    sibling_summary_similarity_max: 0.85, root_summary_similarity_max: 0.9,
  };
  const codesFor = (summary, heading, isRoot) =>
    quality.checkSummary({ summary, heading, isRoot: !!isRoot, limits }).map(r => r.code);

  const good = 'Configures TLS termination at the gateway using the tls.mode setting, which accepts off, terminate, or passthrough depending on where the certificate lives.';
  eq('quality: a specific in-range summary passes', codesFor(good, 'TLS modes').length, 0);

  ok('quality: rejects "Documentation covering..."',
    codesFor('Documentation covering the configuration and usage of the gateway service and its many related operational settings.', 'TLS modes').includes('generic_documentation_covering'));
  ok('quality: rejects "This section discusses..."',
    codesFor('This section discusses the configuration and usage of the gateway service and its many related operational settings here.', 'TLS modes').includes('generic_this_section'));
  ok('quality: rejects "This document contains information about..."',
    codesFor('This document contains information about the configuration and usage of the service and its many related operational settings.', 'TLS modes').includes('generic_this_document'));
  ok('quality: rejects the boilerplate config/usage/operations line',
    codesFor('Covers configuration, usage, and operational guidance for the gateway service across every supported deployment topology today.', 'TLS modes').includes('generic_covers_config_usage'));
  ok('quality: rejects redirect language on a real document',
    codesFor('Redirecting to the new configuration reference page which now holds all of the material that used to live here.', 'TLS modes').includes('redirect_language'));

  ok('quality: rejects a bare repetition of the heading',
    codesFor('TLS modes', 'TLS modes').includes('repeats_heading'));
  ok('quality: rejects a summary that adds nothing beyond the heading',
    codesFor('TLS modes and TLS modes.', 'TLS modes').includes('adds_nothing_to_heading'));

  ok('quality: rejects a too-short summary', codesFor('Sets tls.mode.', 'TLS modes').includes('too_short'));
  ok('quality: rejects a too-long summary',
    codesFor(new Array(70).fill('configuration').join(' '), 'TLS modes').includes('too_long'));
  ok('quality: rejects a missing summary', codesFor(null, 'TLS modes').includes('summary_missing'));
  ok('quality: root summaries use the wider word bounds',
    codesFor(good, 'doc.md', true).includes('too_short'));

  // Similarity
  ok('similarity: identical text scores 1', similarity.jaccard('alpha beta gamma', 'alpha beta gamma') === 1);
  ok('similarity: disjoint text scores 0', similarity.jaccard('alpha beta', 'gamma delta') === 0);
  ok('similarity: stopwords do not inflate the score',
    similarity.jaccard('the quick brown fox', 'the slow green turtle') === 0);

  // Sibling distinctness on a whole tree
  const treeWithDupes = {
    file: 'a.md', doc_type: 't', root_summary: good + ' It also documents the upstream selection rules and the retry budget applied to each request.',
    source_fingerprint: { line_count: 10, sha256: 'a'.repeat(64) },
    children: [
      { heading: 'A', level: 1, node_id: 'a_a', summary: good, children: [], content_ref: { lines: [1, 5] } },
      { heading: 'B', level: 1, node_id: 'a_b', summary: good, children: [], content_ref: { lines: [6, 10] } },
    ],
  };
  const dupeFindings = quality.checkTree(treeWithDupes, limits);
  ok('quality: near-identical sibling summaries are flagged',
    dupeFindings.some(f => f.code === 'sibling_summaries_too_similar'),
    JSON.stringify(dupeFindings.map(f => f.code)));

  const rootDupes = quality.checkRootDistinctness([
    { file: 'a.md', root_summary: good },
    { file: 'b.md', root_summary: good },
  ], limits);
  ok('quality: indistinguishable root summaries are flagged across documents',
    rootDupes.length === 1 && rootDupes[0].code === 'root_summaries_too_similar');
}

// -- semantic queue and merge -----------------------------------------------

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsearch-sem-'));
  try {
    const indexDir = path.join(tmp, '.index');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, 'config.json'), JSON.stringify(baseConfig(FIXTURES, {
      vault: { type: 'homogeneous', ingestion_directory: FIXTURES, doc_type_path_mappings: {} },
    }), null, 2));

    const treeDir = path.join(tmp, 'trees');
    fs.mkdirSync(treeDir, { recursive: true });
    for (const f of ['substantive.md', 'nested-introduction.md']) {
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'build-tree.js'),
        '--source', path.join(FIXTURES, f),
        '--doc-type', 'technical_documentation',
        '--out', path.join(treeDir, pathsLib.treeFilename(f)),
        '--cwd', tmp,
      ], { encoding: 'utf8' });
    }

    const queueDir = path.join(tmp, 'queue');
    const queueOut = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-semantic-queue.js'),
      '--tree-dir', treeDir, '--out-dir', queueDir, '--cwd', tmp,
    ], { encoding: 'utf8' }));

    eq('queue: reports both documents', queueOut.documents, 2);
    ok('queue: produced at least one batch', queueOut.batches.length >= 1);

    const batchFiles = fs.readdirSync(queueDir).filter(f => f.endsWith('.json')).sort();
    const batches = batchFiles.map(f => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8')));
    const allTasks = batches.flatMap(b => b.documents.flatMap(d => d.tasks));

    ok('queue: every task carries its own content', allTasks.every(t => typeof t.content === 'string'));
    ok('queue: every task carries a heading path', allTasks.every(t => Array.isArray(t.heading_path)));
    ok('queue: node tasks carry sibling headings for distinctness',
      allTasks.filter(t => t.kind === 'node').every(t => Array.isArray(t.sibling_headings)));
    ok('queue: every document block carries the full outline',
      batches.every(b => b.documents.every(d => Array.isArray(d.outline) && d.outline.length > 0)));
    ok('queue: a root task exists per document',
      allTasks.filter(t => t.kind === 'root').length === 2);
    ok('queue: batches respect the node budget',
      batches.every(b => b.documents.reduce((n, d) => n + d.tasks.length, 0) <= 12),
      JSON.stringify(batches.map(b => b.documents.reduce((n, d) => n + d.tasks.length, 0))));
    ok('queue: instructions and output schema travel with the batch',
      batches.every(b => b.instructions && b.output_schema));

    // Simulate a worker: every summary distinct and specific enough to pass.
    const resultsDir = path.join(tmp, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    let counter = 0;
    const filler = [
      'gateway binary checksum verification minisign signature release artifact tampering',
      'listen upstream tls mode terminate passthrough certificate origin handling',
      'kernel memory outbound port binding requirement host provisioning baseline',
      'config yaml parse failure exit status seventy eight check-config diagnostics',
      'proxy pass host header upstream absolute url rewriting nginx directive',
      'cloudflare ssl full strict flexible plaintext origin secure cookie breakage',
    ];
    batches.forEach((b, bi) => {
      const results = b.documents.flatMap(d => d.tasks.map(t => {
        counter++;
        const words = filler[counter % filler.length];
        return {
          task_id: t.task_id,
          summary: `Covers ${t.heading} in terms of ${words}, plus the ${counter} specific operational values and constraints that section states directly for operators.`,
          topics: ['alpha', 'beta', 'gamma'],
        };
      }));
      fs.writeFileSync(path.join(resultsDir, `${b.batch_id}.json`), JSON.stringify({ batch_id: b.batch_id, results }, null, 2));
    });

    const mergedDir = path.join(tmp, 'merged');
    let mergeOut;
    try {
      mergeOut = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'merge-semantic-results.js'),
        '--tree-dir', treeDir, '--results-dir', resultsDir, '--out-dir', mergedDir, '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) {
      mergeOut = JSON.parse(String(err.stdout || '{}'));
    }

    eq('merge: applied results to both documents', mergeOut.documents_merged, 2);
    ok('merge: no structural errors after merging',
      mergeOut.documents.every(d => d.structural_errors.length === 0),
      JSON.stringify(mergeOut.documents.map(d => d.structural_errors)));
    ok('merge: coverage still complete after merging',
      mergeOut.documents.every(d => d.coverage && d.coverage.uncovered_count === 0));

    const mergedTree = JSON.parse(fs.readFileSync(path.join(mergedDir, 'substantive.json'), 'utf8'));
    const skeleton = JSON.parse(fs.readFileSync(path.join(treeDir, 'substantive.json'), 'utf8'));
    ok('merge: every summary is now filled in',
      allNodes(mergedTree.children).every(n => typeof n.summary === 'string' && n.summary.length > 0));
    ok('merge: root_summary is filled in', typeof mergedTree.root_summary === 'string');
    ok('merge: node_ids are untouched',
      JSON.stringify(allNodes(mergedTree.children).map(n => n.node_id)) ===
      JSON.stringify(allNodes(skeleton.children).map(n => n.node_id)));
    ok('merge: content_refs are untouched',
      JSON.stringify(allNodes(mergedTree.children).map(n => n.content_ref)) ===
      JSON.stringify(allNodes(skeleton.children).map(n => n.content_ref)));

    // A worker that tries to write structural fields must have them dropped.
    const tamperDir = path.join(tmp, 'tamper');
    fs.mkdirSync(tamperDir, { recursive: true });
    const firstBatch = batches[0];
    const tamperResults = firstBatch.documents.flatMap(d => d.tasks.map(t => ({
      task_id: t.task_id,
      summary: 'A perfectly reasonable looking summary that names concrete settings, commands, and constraints for operators to find quickly.',
      topics: ['x'],
      children: [{ heading: 'injected' }],
      content_ref: { lines: [1, 1] },
      node_id: 'attacker_supplied_id',
    })));
    fs.writeFileSync(path.join(tamperDir, 'batch-001.json'),
      JSON.stringify({ batch_id: 'batch-001', results: tamperResults }, null, 2));

    let tamperOut;
    try {
      tamperOut = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'merge-semantic-results.js'),
        '--tree-dir', treeDir, '--results-dir', tamperDir, '--out-dir', path.join(tmp, 'tampered'), '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) {
      tamperOut = JSON.parse(String(err.stdout || '{}'));
    }

    ok('merge: structural fields in results are reported as rejected',
      tamperOut.rejected_fields.some(r => r.field === 'children') &&
      tamperOut.rejected_fields.some(r => r.field === 'content_ref'),
      JSON.stringify(tamperOut.rejected_fields.slice(0, 5)));

    const tamperedTree = JSON.parse(fs.readFileSync(path.join(tmp, 'tampered', 'substantive.json'), 'utf8'));
    ok('merge: injected children never reach the tree',
      JSON.stringify(allNodes(tamperedTree.children).map(n => n.heading)) ===
      JSON.stringify(allNodes(skeleton.children).map(n => n.heading)));
    ok('merge: injected node_id never reaches the tree',
      !allNodes(tamperedTree.children).some(n => n.node_id === 'attacker_supplied_id'));

    // Bad summaries must come back with actionable reasons attached.
    const badDir = path.join(tmp, 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    const badResults = firstBatch.documents.flatMap(d => d.tasks.map(t => ({
      task_id: t.task_id,
      summary: 'This section discusses the topic.',
      topics: [],
    })));
    fs.writeFileSync(path.join(badDir, 'batch-001.json'),
      JSON.stringify({ batch_id: 'batch-001', results: badResults }, null, 2));

    let badOut;
    let badExit = 0;
    try {
      badOut = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'merge-semantic-results.js'),
        '--tree-dir', treeDir, '--results-dir', badDir, '--out-dir', path.join(tmp, 'badout'), '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) {
      badExit = err.status;
      badOut = JSON.parse(String(err.stdout || '{}'));
    }

    eq('merge: generic summaries fail the run', badOut.ok, false);
    eq('merge: a failing merge exits non-zero', badExit, 1);
    ok('merge: retry tasks carry specific reasons',
      badOut.retry_tasks.length > 0 && badOut.retry_tasks.every(t => t.reasons.length > 0));
    ok('merge: the generic-opening rule is among the reasons',
      JSON.stringify(badOut.retry_tasks).includes('generic_this_section'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -- the CLI contract -------------------------------------------------------

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsearch-test-'));
  try {
    fs.mkdirSync(path.join(tmp, '.index'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.index', 'config.json'),
      JSON.stringify(baseConfig(FIXTURES, {
        vault: {
          type: 'homogeneous',
          ingestion_directory: FIXTURES,
          doc_type_path_mappings: {},
        },
      }), null, 2)
    );

    const out = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-tree.js'),
      '--source', path.join(FIXTURES, 'substantive.md'),
      '--doc-type', 'technical_documentation',
      '--cwd', tmp,
    ], { encoding: 'utf8' });

    const payload = JSON.parse(out);
    ok('cli: stdout is a single parseable JSON object', Boolean(payload));
    eq('cli: reports ok', payload.ok, true);
    eq('cli: derives the tree filename', payload.tree_index, 'substantive.json');
    ok('cli: returns the tree when no --out is given', Boolean(payload.tree));
    ok('cli: reports coverage', payload.validation.coverage.uncovered_count === 0);

    const outFile = path.join(tmp, 'out.json');
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-tree.js'),
      '--source', path.join(FIXTURES, 'substantive.md'),
      '--doc-type', 'technical_documentation',
      '--out', outFile,
      '--cwd', tmp,
    ], { encoding: 'utf8' });
    ok('cli: --out writes the tree to disk', fs.existsSync(outFile));

    const validated = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'validate-tree.js'),
      '--tree', outFile,
      '--cwd', tmp,
    ], { encoding: 'utf8' });
    eq('cli: validate-tree accepts the tree build-tree wrote', JSON.parse(validated).ok, true);

    // A path outside the ingestion directory must be refused, not silently
    // indexed into a tree query could never read back.
    let refused = false;
    try {
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'build-tree.js'),
        '--source', path.join(ROOT, 'README.md'),
        '--doc-type', 'technical_documentation',
        '--cwd', tmp,
      ], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      refused = /outside the configured ingestion directory/.test(String(err.stdout || ''));
    }
    ok('cli: refuses a source outside the ingestion directory', refused);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -- end-to-end publication -------------------------------------------------

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsearch-e2e-'));
  try {
    const indexDir = path.join(tmp, '.index');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, 'config.json'), JSON.stringify(baseConfig(FIXTURES, {
      vault: { type: 'homogeneous', ingestion_directory: FIXTURES, doc_type_path_mappings: {} },
      chunking: { fallback_chunk_size_lines: 150, max_section_size_lines: 200 },
    }), null, 2));

    const run = path.join(indexDir, 'staging', 'testrun');
    const treeDir = path.join(run, 'trees');
    const mergedDir = path.join(run, 'merged');
    const queueDir = path.join(run, 'semantic-queue');
    const resultsDir = path.join(run, 'semantic-results');
    for (const d of [treeDir, mergedDir, queueDir, resultsDir]) fs.mkdirSync(d, { recursive: true });

    const docs = ['substantive.md', 'nested-introduction.md'];
    for (const f of docs) {
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'build-tree.js'),
        '--source', path.join(FIXTURES, f), '--doc-type', 'technical_documentation',
        '--out', path.join(treeDir, pathsLib.treeFilename(f)), '--cwd', tmp,
      ], { encoding: 'utf8' });
    }

    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-semantic-queue.js'),
      '--tree-dir', treeDir, '--out-dir', queueDir, '--cwd', tmp,
    ], { encoding: 'utf8' });

    // Stand-in worker output. Each summary is given its own vocabulary so it
    // clears the sibling-distinctness rule — the same thing a real worker has
    // to do, and the reason tasks ship with their siblings' headings.
    let n = 0;
    const distinctTerms = i => Array.from({ length: 12 }, (_, k) => `term${i}x${k}`).join(' ');
    for (const bf of fs.readdirSync(queueDir).filter(f => f.endsWith('.json'))) {
      const b = JSON.parse(fs.readFileSync(path.join(queueDir, bf), 'utf8'));
      const results = b.documents.flatMap(d => d.tasks.map(t => {
        n++;
        const body = `${t.heading} in ${d.file}: ${distinctTerms(n)}.`;
        return {
          task_id: t.task_id,
          summary: t.kind === 'root'
            ? `${body} ${distinctTerms(n + 500)} ${distinctTerms(n + 900)}`
            : body,
          topics: [`topic-${n}a`, `topic-${n}b`],
          metadata: {},
        };
      }));
      fs.writeFileSync(path.join(resultsDir, bf), JSON.stringify({ batch_id: b.batch_id, results }, null, 2));
    }

    try {
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'merge-semantic-results.js'),
        '--tree-dir', treeDir, '--results-dir', resultsDir, '--out-dir', mergedDir,
        '--cwd', tmp, '--date', '2026-08-10',
      ], { encoding: 'utf8' });
    } catch (err) { /* quality findings do not block this structural test */ }

    ok('e2e: merge produced a leaves file', fs.existsSync(path.join(mergedDir, 'leaves.json')));
    const leavesDoc = JSON.parse(fs.readFileSync(path.join(mergedDir, 'leaves.json'), 'utf8'));
    ok('e2e: a leaf payload exists per document', leavesDoc.leaves.length >= 1);
    ok('e2e: leaf payloads carry a bare tree_index filename',
      leavesDoc.leaves.every(l => l.tree_index && !l.tree_index.includes('/')));
    ok('e2e: leaf payloads carry the run date', leavesDoc.leaves.every(l => l.date_added === '2026-08-10'));

    // Dry run must change nothing on disk.
    const dry = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'publish-batch.js'),
      '--merged-dir', mergedDir, '--leaves', path.join(mergedDir, 'leaves.json'),
      '--backup-dir', path.join(run, 'backup'), '--cwd', tmp, '--dry-run',
    ], { encoding: 'utf8' }));
    eq('e2e: dry run reports ok', dry.ok, true);
    ok('e2e: dry run wrote no trees directory', !fs.existsSync(path.join(indexDir, 'trees')));
    ok('e2e: dry run wrote no routing index', !fs.existsSync(path.join(indexDir, 'document-summary-index.json')));

    const pub = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'publish-batch.js'),
      '--merged-dir', mergedDir, '--leaves', path.join(mergedDir, 'leaves.json'),
      '--backup-dir', path.join(run, 'backup'), '--cwd', tmp,
    ], { encoding: 'utf8' }));

    eq('e2e: publication reports ok', pub.ok, true);
    eq('e2e: published both trees', pub.published_count, leavesDoc.leaves.length);
    ok('e2e: trees are on disk', fs.existsSync(path.join(indexDir, 'trees', 'substantive.json')));
    ok('e2e: routing index is on disk', fs.existsSync(path.join(indexDir, 'document-summary-index.json')));
    ok('e2e: staging no longer holds the published trees',
      !fs.existsSync(path.join(mergedDir, 'substantive.json')));

    const publishedIndex = JSON.parse(fs.readFileSync(path.join(indexDir, 'document-summary-index.json'), 'utf8'));
    const dsiLib = require(path.join(ROOT, 'scripts', 'lib', 'dsi'));
    eq('e2e: routing index contains a leaf per document',
      dsiLib.collectLeaves(publishedIndex).length, leavesDoc.leaves.length);
    ok('e2e: published trees pass the shared validator',
      JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'validate-tree.js'), '--all', '--cwd', tmp,
      ], { encoding: 'utf8' })).ok);

    // Re-publishing the same documents in ingest mode must be refused.
    for (const f of docs) {
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'build-tree.js'),
        '--source', path.join(FIXTURES, f), '--doc-type', 'technical_documentation',
        '--out', path.join(mergedDir, pathsLib.treeFilename(f)), '--cwd', tmp,
      ], { encoding: 'utf8' });
    }
    let second;
    try {
      second = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'publish-batch.js'),
        '--merged-dir', mergedDir, '--leaves', path.join(mergedDir, 'leaves.json'),
        '--backup-dir', path.join(run, 'backup2'), '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) { second = JSON.parse(String(err.stdout || '{}')); }
    eq('e2e: ingest mode refuses an already-indexed document', second.ok, false);
    ok('e2e: refusal names re-indexing as the fix',
      JSON.stringify(second.rejected).includes('modify'));

    // -- doctor --------------------------------------------------------------
    const doctorOut = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'doctor.js'), '--cwd', tmp,
    ], { encoding: 'utf8' }));
    eq('doctor: a freshly published index is healthy', doctorOut.ok, true);
    eq('doctor: counts the published documents', doctorOut.stats.documents, leavesDoc.leaves.length);
    ok('doctor: reports the config summary', Boolean(doctorOut.config_summary.hierarchy_fields));

    let deepOut;
    try {
      deepOut = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'doctor.js'), '--deep', '--quality', '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) { deepOut = JSON.parse(String(err.stdout || '{}')); }
    ok('doctor: deep mode inspects every tree', deepOut.deep.per_document.length === leavesDoc.leaves.length);
    ok('doctor: deep mode finds no structural errors',
      deepOut.deep.per_document.every(d => d.valid), JSON.stringify(deepOut.deep.per_document));
    ok('doctor: deep mode reports full coverage',
      deepOut.deep.per_document.every(d => d.coverage === 1));
    ok('doctor: quality mode reports a generic-summary rate',
      deepOut.deep.quality && typeof deepOut.deep.quality.generic_rate === 'number');

    // Doctor must notice a source that changed after indexing.
    const sourceCopy = fs.readFileSync(path.join(FIXTURES, 'substantive.md'), 'utf8');
    fs.appendFileSync(path.join(FIXTURES, 'substantive.md'), '\nAppended line to trigger staleness.\n');
    let staleOut;
    try {
      staleOut = JSON.parse(execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'doctor.js'), '--deep', '--cwd', tmp,
      ], { encoding: 'utf8' }));
    } catch (err) { staleOut = JSON.parse(String(err.stdout || '{}')); }
    ok('doctor: detects a source that changed after indexing',
      staleOut.findings.some(f => f.code === 'stale_source'),
      JSON.stringify(staleOut.findings.map(f => f.code)));

    // -- sync plan -----------------------------------------------------------
    const syncOut = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'sync-plan.js'), '--cwd', tmp,
    ], { encoding: 'utf8' }));
    ok('sync: the changed file is queued for modify',
      syncOut.to_modify.some(m => m.file === 'substantive.md'), JSON.stringify(syncOut.totals));
    ok('sync: unindexed substantive files are queued for ingest',
      syncOut.to_ingest.some(i => i.file === 'headerless.md'), JSON.stringify(syncOut.to_ingest));
    ok('sync: redirects and placeholders are excluded rather than ingested',
      syncOut.excluded.some(e => e.file === 'redirect.md') &&
      syncOut.excluded.some(e => e.file === 'placeholder.md'));
    ok('sync: the unchanged document is reported as current',
      syncOut.unchanged.some(u => u.file === 'nested-introduction.md'));

    fs.writeFileSync(path.join(FIXTURES, 'substantive.md'), sourceCopy);

    // -- remove --------------------------------------------------------------
    const removeDry = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'remove-document.js'),
      '--file', 'nested-introduction.md', '--cwd', tmp, '--dry-run',
    ], { encoding: 'utf8' }));
    eq('remove: dry run reports what it would remove', removeDry.would_remove.length, 1);
    ok('remove: dry run leaves the tree in place',
      fs.existsSync(path.join(indexDir, 'trees', 'nested-introduction.json')));

    const removeOut = JSON.parse(execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'remove-document.js'),
      '--file', 'nested-introduction.md', '--cwd', tmp,
    ], { encoding: 'utf8' }));
    eq('remove: reports success', removeOut.ok, true);
    ok('remove: the tree file is gone from the index',
      !fs.existsSync(path.join(indexDir, 'trees', 'nested-introduction.json')));
    ok('remove: the tree was preserved in the backup directory',
      removeOut.trees_moved_to_backup.length === 1 &&
      fs.existsSync(removeOut.trees_moved_to_backup[0].replace(/\//g, path.sep)));
    const afterRemove = JSON.parse(fs.readFileSync(path.join(indexDir, 'document-summary-index.json'), 'utf8'));
    ok('remove: the routing entry is gone',
      !require(path.join(ROOT, 'scripts', 'lib', 'dsi')).leafFileSet(afterRemove).has('nested-introduction.md'));

    const removeMissing = (() => {
      try {
        return JSON.parse(execFileSync(process.execPath, [
          path.join(ROOT, 'scripts', 'remove-document.js'),
          '--file', 'never-indexed.md', '--cwd', tmp,
        ], { encoding: 'utf8' }));
      } catch (err) { return JSON.parse(String(err.stdout || '{}')); }
    })();
    eq('remove: removing an unindexed file fails cleanly', removeMissing.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -- transactional rollback --------------------------------------------------

{
  const transaction = require(path.join(ROOT, 'scripts', 'lib', 'transaction'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsearch-tx-'));
  try {
    const indexDir = path.join(tmp, '.index');
    const treesDir = path.join(indexDir, 'trees');
    fs.mkdirSync(treesDir, { recursive: true });

    const originalIndex = { type: 'root', summary: 'original', children: [] };
    fs.writeFileSync(path.join(indexDir, 'document-summary-index.json'), JSON.stringify(originalIndex, null, 2));
    fs.writeFileSync(path.join(treesDir, 'existing.json'), JSON.stringify({ marker: 'original-tree' }));

    const stagingDir = path.join(tmp, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'existing.json'), JSON.stringify({ marker: 'replacement-tree' }));
    fs.writeFileSync(path.join(stagingDir, 'brand-new.json'), JSON.stringify({ marker: 'new-tree' }));

    const outcome = transaction.publish({
      cwd: tmp,
      trees: [
        { stagedPath: path.join(stagingDir, 'existing.json'), treeIndex: 'existing.json' },
        { stagedPath: path.join(stagingDir, 'brand-new.json'), treeIndex: 'brand-new.json' },
      ],
      nextIndex: { type: 'root', summary: 'replacement', children: [] },
      backupDir: path.join(tmp, 'backup'),
      // Simulates verification failing after everything has been written.
      verifyIndex: () => ['simulated verification failure'],
    });

    eq('rollback: publication reports failure', outcome.ok, false);
    eq('rollback: publication reports it rolled back', outcome.rolled_back, true);

    const restoredIndex = JSON.parse(fs.readFileSync(path.join(indexDir, 'document-summary-index.json'), 'utf8'));
    eq('rollback: the routing index is restored to its prior content', restoredIndex.summary, 'original');

    const restoredTree = JSON.parse(fs.readFileSync(path.join(treesDir, 'existing.json'), 'utf8'));
    eq('rollback: an overwritten tree is restored', restoredTree.marker, 'original-tree');
    ok('rollback: a newly created tree is removed', !fs.existsSync(path.join(treesDir, 'brand-new.json')));

    // The happy path through the same engine still publishes.
    fs.writeFileSync(path.join(stagingDir, 'ok.json'), JSON.stringify({ marker: 'fine' }));
    const good = transaction.publish({
      cwd: tmp,
      trees: [{ stagedPath: path.join(stagingDir, 'ok.json'), treeIndex: 'ok.json' }],
      nextIndex: { type: 'root', summary: 'accepted', children: [] },
      backupDir: path.join(tmp, 'backup2'),
      verifyIndex: () => [],
    });
    eq('rollback: a clean publication still succeeds', good.ok, true);
    ok('rollback: the clean publication left its tree in place', fs.existsSync(path.join(treesDir, 'ok.json')));
    eq('rollback: the clean publication replaced the routing index',
      JSON.parse(fs.readFileSync(path.join(indexDir, 'document-summary-index.json'), 'utf8')).summary, 'accepted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -- report -----------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`  All ${passed} assertions passed.`);
  process.exit(0);
}
console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
for (const f of failures) {
  console.log(`  x ${f.name}`);
  if (f.detail) console.log(`      ${String(f.detail).split('\n').join('\n      ')}`);
}
console.log('');
process.exit(1);
