#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// publish-batch.js — the only writer into `.index/`.
//
//   node publish-batch.js --merged-dir <dir> --leaves <leaves.json>
//                         --backup-dir <dir> [--mode ingest|modify]
//                         [--cwd <vault>] [--dry-run]
//
// Revalidates everything from scratch — trees against their sources, the next
// routing index against the configured hierarchy — then publishes under the
// transaction rules in lib/transaction.js. A document that fails anything is
// dropped from the run rather than degrading the publication.
//
// Exactly one routing-index write happens per invocation, no matter how many
// documents are in the batch. That is what makes parallel tree building safe:
// many builders, one writer.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const fingerprintLib = require('./lib/fingerprint');
const markdown = require('./lib/markdown');
const validate = require('./lib/validate');
const dsi = require('./lib/dsi');
const transaction = require('./lib/transaction');

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const mode = args.mode ? String(args.mode) : 'ingest';
  if (mode !== 'ingest' && mode !== 'modify') {
    throw cli.fail('usage', "--mode must be 'ingest' or 'modify'.");
  }

  if (!args['merged-dir']) throw cli.fail('usage', 'publish-batch.js requires --merged-dir.');
  if (!args.leaves) throw cli.fail('usage', 'publish-batch.js requires --leaves.');

  const mergedDir = path.resolve(cwd, String(args['merged-dir']));
  const leavesPath = path.resolve(cwd, String(args.leaves));
  const backupDir = args['backup-dir']
    ? path.resolve(cwd, String(args['backup-dir']))
    : path.join(mergedDir, '..', 'backup');

  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);
  const hierarchy = (config.doc_summary_index && config.doc_summary_index.hierarchy_fields) || [];
  const baseSchema = (config.doc_types && config.doc_types.base_schema) || [];
  const wantPages = !!(config.source && config.source.page_numbers_in_citations);

  const leavesDoc = JSON.parse(fs.readFileSync(leavesPath, 'utf8'));
  const leaves = leavesDoc.leaves || [];

  const currentIndex = dsi.loadOrEmpty(cwd);
  const alreadyIndexed = dsi.leafFileSet(currentIndex);
  const existingTrees = fs.existsSync(paths.treesDir(cwd))
    ? new Set(fs.readdirSync(paths.treesDir(cwd)).filter(f => f.endsWith('.json')))
    : new Set();

  const accepted = [];
  const rejected = [];

  // -- revalidate every staged tree against its real source -----------------
  for (const leaf of leaves) {
    const treeIndex = leaf.tree_index;
    const stagedPath = path.join(mergedDir, treeIndex);

    if (!fs.existsSync(stagedPath)) {
      rejected.push({ file: leaf.file, state: 'failed_publish', reason: `Staged tree ${treeIndex} not found in ${mergedDir}.` });
      continue;
    }
    if (mode === 'ingest' && (existingTrees.has(treeIndex) || alreadyIndexed.has(leaf.file))) {
      rejected.push({ file: leaf.file, state: 'failed_publish', reason: 'Already indexed. Use modify to re-index an existing document.' });
      continue;
    }

    let tree;
    try {
      tree = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
    } catch (err) {
      rejected.push({ file: leaf.file, state: 'failed_structural_validation', reason: `Staged tree is not valid JSON: ${err.message}` });
      continue;
    }

    const sourcePath = path.join(ingestionDir, tree.file);
    const opts = { wantPages };
    if (fs.existsSync(sourcePath)) {
      const content = fs.readFileSync(sourcePath, 'utf8');
      opts.parsed = markdown.parse(content);
      opts.fingerprint = fingerprintLib.ofContent(content);
    } else {
      rejected.push({ file: leaf.file, state: 'failed_structural_validation', reason: `Source file missing at ${sourcePath}.` });
      continue;
    }

    const result = validate.validateTree(tree, opts);
    if (!result.ok) {
      rejected.push({
        file: leaf.file,
        state: 'failed_structural_validation',
        reason: `${result.errors.length} validation error(s).`,
        errors: result.errors.slice(0, 10),
      });
      continue;
    }

    accepted.push({ leaf, treeIndex, stagedPath, coverage: result.coverage });
  }

  // -- build the next routing index in memory -------------------------------
  const nextIndex = JSON.parse(JSON.stringify(currentIndex));
  const unknownPlacements = [];

  for (const item of accepted) {
    if (mode === 'modify') dsi.removeLeaf(nextIndex, item.leaf.file);
    const missing = dsi.unknownFieldsFor(hierarchy, item.leaf);
    if (missing.length) unknownPlacements.push({ file: item.leaf.file, fields: missing });
    const parent = dsi.ensurePath(nextIndex, hierarchy, item.leaf);
    const lastField = hierarchy[hierarchy.length - 1];
    const leafNode = Object.assign({}, item.leaf, {
      type: 'leaf',
      field: lastField || null,
      value: lastField ? (item.leaf[lastField] === undefined || item.leaf[lastField] === null ? 'unknown' : item.leaf[lastField]) : null,
    });
    delete leafNode.children;
    parent.children = parent.children || [];
    parent.children.push(leafNode);
  }

  const indexCheck = validate.validateIndex(nextIndex, {
    hierarchyFields: hierarchy,
    baseSchema,
    // Trees not yet moved into place would read as dangling, so check against
    // what will exist after publication rather than what exists now.
    availableTrees: new Set([...existingTrees, ...accepted.map(a => a.treeIndex)]),
  });

  if (!indexCheck.ok) {
    return {
      payload: {
        ok: false,
        stage: 'next_index_validation',
        message: 'The next routing index failed validation. Nothing was published.',
        errors: indexCheck.errors,
        accepted: accepted.length,
        rejected,
      },
      exitCode: cli.EXIT_FAILED,
    };
  }

  if (args['dry-run']) {
    return {
      payload: {
        ok: true,
        dry_run: true,
        would_publish: accepted.map(a => ({ file: a.leaf.file, tree_index: a.treeIndex })),
        rejected,
        next_index_leaves: indexCheck.leaves,
        unknown_placements: unknownPlacements,
      },
      exitCode: cli.EXIT_OK,
    };
  }

  // -- aliases --------------------------------------------------------------
  // Redirect pages are not indexed as documents, but their paths still appear
  // in links and in user requests. Recording where each one points lets query
  // resolve a redirect path straight to its canonical document instead of
  // reporting nothing found.
  const aliasPath = path.join(paths.indexDir(cwd), 'aliases.json');
  let aliasBackup = null;
  let aliasesWritten = 0;
  if (args.aliases) {
    const incoming = JSON.parse(fs.readFileSync(path.resolve(cwd, String(args.aliases)), 'utf8'));
    const list = Array.isArray(incoming) ? incoming : (incoming.aliases || []);
    const current = fs.existsSync(aliasPath) ? JSON.parse(fs.readFileSync(aliasPath, 'utf8')) : { aliases: {} };
    current.aliases = current.aliases || {};
    for (const entry of list) {
      if (entry && entry.from && entry.to) current.aliases[entry.from] = entry.to;
    }
    aliasesWritten = list.length;
    aliasBackup = transaction.backupFile(aliasPath, backupDir, 'aliases.json');
    transaction.atomicWrite(aliasPath, JSON.stringify(current, null, 2) + '\n');
  }

  // -- publish --------------------------------------------------------------
  const outcome = transaction.publish({
    cwd,
    trees: accepted.map(a => ({ stagedPath: a.stagedPath, treeIndex: a.treeIndex })),
    nextIndex,
    backupDir,
    verifyIndex: (published) => {
      const problems = [];
      const check = validate.validateIndex(published, { hierarchyFields: hierarchy, baseSchema });
      if (!check.ok) problems.push(`published routing index failed validation (${check.errors.length} error(s))`);
      const publishedFiles = dsi.leafFileSet(published);
      for (const a of accepted) {
        if (!publishedFiles.has(a.leaf.file)) problems.push(`${a.leaf.file} is absent from the published routing index`);
      }
      return problems;
    },
  });

  // The alias map is part of the same transaction: if publication rolled back,
  // it must roll back too, or query would resolve redirects to documents the
  // index no longer contains.
  if (outcome.rolled_back && args.aliases) {
    try {
      if (aliasBackup && fs.existsSync(aliasBackup)) transaction.atomicWrite(aliasPath, fs.readFileSync(aliasBackup));
      else if (fs.existsSync(aliasPath)) fs.unlinkSync(aliasPath);
    } catch (_) { /* reported via rolled_back below */ }
  }

  const transactionRecord = {
    timestamp: new Date().toISOString(),
    mode,
    published: outcome.published,
    rejected,
    failures: outcome.failures,
    rolled_back: outcome.rolled_back,
    backup_dir: paths.toPosix(backupDir),
  };
  try {
    fs.writeFileSync(path.join(path.dirname(backupDir), 'transaction.json'), JSON.stringify(transactionRecord, null, 2) + '\n');
  } catch (_) { /* the payload below still reports everything */ }

  return {
    payload: {
      ok: outcome.ok && rejected.length === 0,
      published: outcome.published,
      published_count: outcome.published.length,
      rejected,
      failures: outcome.failures,
      rolled_back: outcome.rolled_back,
      rollback_reason: outcome.reason || null,
      unknown_placements: unknownPlacements,
      aliases_recorded: aliasesWritten,
      backup_dir: paths.toPosix(backupDir),
      routing_index_leaves: indexCheck.leaves,
    },
    exitCode: outcome.ok ? (rejected.length ? cli.EXIT_FAILED : cli.EXIT_OK) : cli.EXIT_FAILED,
  };
}

cli.run(main);
