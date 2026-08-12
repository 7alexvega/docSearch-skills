#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// merge-semantic-results.js — fold model output into skeletons, safely.
//
//   node merge-semantic-results.js --tree-dir <dir> --results-dir <dir>
//                                  --out-dir <dir> [--cwd <vault>]
//
// The merge is deliberately narrow: `summary`, `root_summary`, and `topics` are
// the only fields a result can influence. Everything else is copied from the
// skeleton. To prove that rather than assert it, a structural signature is
// taken before and after the merge and compared — if they differ at all, the
// merge is rejected outright.
//
// Output is the merged trees plus, when anything fails the quality rules, a
// retry list carrying the specific reasons. Those reasons are the entire point:
// a rejection the model cannot act on just fails twice at double the cost.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const markdown = require('./lib/markdown');
const validate = require('./lib/validate');
const quality = require('./lib/quality');

const ALLOWED_RESULT_FIELDS = new Set(['task_id', 'node_id', 'kind', 'summary', 'topics', 'metadata', 'file']);

// Everything about a tree except the fields a model is allowed to write.
function structuralSignature(tree) {
  const shape = node => ({
    h: node.heading,
    l: node.level,
    id: node.node_id,
    p: node.page_range === undefined ? undefined : node.page_range,
    c: node.content_ref ? node.content_ref.lines : null,
    k: (node.children || []).map(shape),
  });
  return JSON.stringify({
    file: tree.file,
    doc_type: tree.doc_type,
    fp: tree.source_fingerprint,
    p: tree.page_range === undefined ? undefined : tree.page_range,
    k: (tree.children || []).map(shape),
  });
}

function collectFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).sort().map(f => path.join(dir, f));
}

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const limits = config.ingestion_quality;
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);
  const wantPages = !!(config.source && config.source.page_numbers_in_citations);

  const treePaths = args['tree-dir']
    ? collectFiles(path.resolve(cwd, String(args['tree-dir'])), '.json')
    : [].concat(args.tree || []).filter(Boolean).map(p => path.resolve(cwd, String(p)));
  const resultPaths = args['results-dir']
    ? collectFiles(path.resolve(cwd, String(args['results-dir'])), '.json')
    : [].concat(args.results || []).filter(Boolean).map(p => path.resolve(cwd, String(p)));

  if (!treePaths.length) throw cli.fail('usage', 'merge-semantic-results.js requires --tree-dir or --tree.');
  if (!resultPaths.length) throw cli.fail('usage', 'merge-semantic-results.js requires --results-dir or --results.');
  if (!args['out-dir']) throw cli.fail('usage', 'merge-semantic-results.js requires --out-dir.');

  const outDir = path.resolve(cwd, String(args['out-dir']));
  paths.ensureDir(outDir);

  // One date for the whole run, so every document ingested together records the
  // same date_added rather than straddling midnight.
  const dateAdded = args.date ? String(args.date) : new Date().toISOString().slice(0, 10);

  // Index every result by task_id, noting any field a model tried to add that
  // it has no business setting.
  const byTaskId = new Map();
  const rejectedFields = [];
  let resultCount = 0;

  for (const rp of resultPaths) {
    let parsedResults;
    try {
      parsedResults = JSON.parse(fs.readFileSync(rp, 'utf8'));
    } catch (err) {
      throw cli.fail('bad_results', `${rp} is not valid JSON: ${err.message}`);
    }
    for (const entry of parsedResults.results || []) {
      if (!entry || !entry.task_id) continue;
      resultCount++;
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_RESULT_FIELDS.has(key)) {
          rejectedFields.push({ task_id: entry.task_id, field: key, source: path.basename(rp) });
        }
      }
      byTaskId.set(entry.task_id, {
        summary: typeof entry.summary === 'string' ? entry.summary : null,
        topics: Array.isArray(entry.topics) ? entry.topics.filter(t => typeof t === 'string') : null,
        metadata: entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : null,
      });
    }
  }

  const documents = [];
  const retryTasks = [];

  for (const tp of treePaths) {
    const tree = JSON.parse(fs.readFileSync(tp, 'utf8'));
    const stem = paths.treeStem(tree.file);
    const before = structuralSignature(tree);

    const missing = [];

    // Root.
    const rootResult = byTaskId.get(`${stem}:__root__`);
    if (rootResult && rootResult.summary) {
      tree.root_summary = rootResult.summary;
      if (rootResult.topics && rootResult.topics.length) tree.topics = rootResult.topics;
    } else {
      missing.push(`${stem}:__root__`);
    }

    // Nodes.
    (function walk(nodes) {
      for (const node of nodes || []) {
        const taskId = `${stem}:${node.node_id}`;
        const result = byTaskId.get(taskId);
        if (result && result.summary) node.summary = result.summary;
        else missing.push(taskId);
        walk(node.children);
      }
    })(tree.children);

    const after = structuralSignature(tree);
    if (before !== after) {
      throw cli.fail('structure_mutated',
        `Merging results into ${tree.file} changed its structure. Only summaries may be written. This is a bug in the merge, not something to work around.`);
    }

    // Structure must still hold against the real source after the merge.
    const sourcePath = path.join(ingestionDir, tree.file);
    const validationOpts = { wantPages };
    if (fs.existsSync(sourcePath)) {
      validationOpts.parsed = markdown.parse(fs.readFileSync(sourcePath, 'utf8'));
    }
    const structural = validate.validateTree(tree, validationOpts);

    const findings = quality.checkTree(tree, limits);
    for (const t of missing) {
      findings.push({ scope: 'node', code: 'summary_missing', task_id: t, message: 'No result was supplied for this task.' });
    }

    const ok = structural.ok && findings.length === 0;
    const outPath = path.join(outDir, paths.treeFilename(tree.file));
    fs.writeFileSync(outPath, JSON.stringify(tree, null, 2) + '\n');

    // Group findings into per-task retry instructions carrying every reason,
    // so a retry prompt can state exactly what to fix.
    const byTask = new Map();
    for (const f of findings) {
      const taskId = f.task_id || (f.scope === 'root' ? `${stem}:__root__` : `${stem}:${f.node_id}`);
      if (!byTask.has(taskId)) byTask.set(taskId, { task_id: taskId, file: tree.file, heading: f.heading || null, reasons: [] });
      byTask.get(taskId).reasons.push({ code: f.code, message: f.message });
    }
    retryTasks.push(...byTask.values());

    // The Document Summary Index leaf for this document. Built here, from
    // validated pieces, so publication never has to re-derive it.
    const schemaFields = (config.doc_types.schemas && config.doc_types.schemas[tree.doc_type]) || [];
    const supplied = (rootResult && rootResult.metadata) || {};
    const leaf = {
      type: 'leaf',
      file: tree.file,
      doc_type: tree.doc_type,
      doc_group: configLib.docGroupFor(config, tree.doc_type) || supplied.doc_group || null,
      topics: (rootResult && rootResult.topics) || [],
      date_added: dateAdded,
      summary: tree.root_summary || null,
      tree_index: paths.treeFilename(tree.file),
    };
    const nullFields = [];
    for (const field of schemaFields) {
      const value = Object.prototype.hasOwnProperty.call(supplied, field) ? supplied[field] : null;
      leaf[field] = value === undefined ? null : value;
      if (leaf[field] === null) nullFields.push(field);
    }
    if (leaf.doc_group === null) nullFields.push('doc_group');

    // Store the routing payload on the tree itself. A tree that carries its own
    // metadata can rebuild its routing entry without re-reading the source or
    // re-running a model, which is what makes full-rebuild recovery lossless
    // rather than a best-effort reconstruction.
    tree.index_metadata = leaf;
    fs.writeFileSync(outPath, JSON.stringify(tree, null, 2) + '\n');

    documents.push({
      file: tree.file,
      out: paths.toPosix(outPath),
      ok,
      root_summary: tree.root_summary || null,
      structural_errors: structural.errors,
      coverage: structural.coverage,
      quality_findings: findings.length,
      findings,
      leaf,
      null_fields: nullFields,
    });
  }

  // Roots must be distinguishable from each other across the whole run.
  const rootFindings = quality.checkRootDistinctness(
    documents.map(d => ({ file: d.file, root_summary: d.root_summary })),
    limits
  );
  for (const f of rootFindings) {
    const doc = documents.find(d => d.file === f.file);
    if (doc) { doc.ok = false; doc.findings.push(f); doc.quality_findings++; }
    const stem = paths.treeStem(f.file);
    retryTasks.push({ task_id: `${stem}:__root__`, file: f.file, heading: null, reasons: [{ code: f.code, message: f.message }] });
  }

  const failed = documents.filter(d => !d.ok);

  // Leaf payloads for every document that passed, written where publication
  // expects them. A failed document contributes no leaf: it must not be
  // routable when its content did not meet the bar.
  fs.writeFileSync(
    path.join(outDir, 'leaves.json'),
    JSON.stringify({
      date_added: dateAdded,
      leaves: documents.filter(d => d.ok).map(d => d.leaf),
      excluded: documents.filter(d => !d.ok).map(d => ({ file: d.file, reason: 'failed_semantic_validation' })),
    }, null, 2) + '\n'
  );

  return {
    payload: {
      ok: failed.length === 0,
      out_dir: paths.toPosix(outDir),
      leaves_file: paths.toPosix(path.join(outDir, 'leaves.json')),
      documents_merged: documents.length,
      results_applied: resultCount,
      rejected_fields: rejectedFields,
      failed: failed.length,
      retry_tasks: retryTasks,
      documents,
    },
    exitCode: failed.length === 0 ? cli.EXIT_OK : cli.EXIT_FAILED,
  };
}

cli.run(main);
