#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// remove-document.js — transactional removal.
//
//   node remove-document.js --file <relative path> [--file <another>]
//                           [--cwd <vault>] [--dry-run]
//
// Builds the next routing index without the named leaves, validates it, backs
// up everything at risk, then publishes and verifies. The tree file is moved
// into the backup directory rather than deleted, so a failed verification can
// put it back.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const validate = require('./lib/validate');
const dsi = require('./lib/dsi');
const transaction = require('./lib/transaction');

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const hierarchy = (config.doc_summary_index && config.doc_summary_index.hierarchy_fields) || [];
  const baseSchema = (config.doc_types && config.doc_types.base_schema) || [];

  const files = [].concat(args.file || [], args._ || []).filter(Boolean).map(String);
  if (!files.length) throw cli.fail('usage', 'Usage: remove-document.js --file <relative path> [--file <another>]');

  const index = dsi.load(cwd);
  const treesDir = paths.treesDir(cwd);

  const targets = [];
  const notFound = [];
  for (const file of files) {
    const leaf = dsi.findLeafByFile(index, file);
    if (!leaf) { notFound.push(file); continue; }
    targets.push({ file, tree_index: leaf.tree_index || paths.treeFilename(file) });
  }

  if (!targets.length) {
    return {
      payload: { ok: false, removed: [], not_found: notFound, message: 'No matching routing index entries found; nothing to remove.' },
      exitCode: cli.EXIT_FAILED,
    };
  }

  const nextIndex = JSON.parse(JSON.stringify(index));
  for (const t of targets) dsi.removeLeaf(nextIndex, t.file);

  const remainingTrees = new Set(
    (fs.existsSync(treesDir) ? fs.readdirSync(treesDir).filter(f => f.endsWith('.json')) : [])
      .filter(f => !targets.some(t => t.tree_index === f))
  );
  const check = validate.validateIndex(nextIndex, { hierarchyFields: hierarchy, baseSchema, availableTrees: remainingTrees });
  if (!check.ok) {
    return {
      payload: { ok: false, stage: 'next_index_validation', errors: check.errors, message: 'The routing index that would result failed validation. Nothing was removed.' },
      exitCode: cli.EXIT_FAILED,
    };
  }

  if (args['dry-run']) {
    return {
      payload: { ok: true, dry_run: true, would_remove: targets, not_found: notFound, remaining_leaves: check.leaves },
      exitCode: cli.EXIT_OK,
    };
  }

  const runId = args['run-id'] ? String(args['run-id']) : `remove-${Date.now()}`;
  const backupDir = path.join(paths.stagingDir(cwd), runId, 'backup');
  paths.ensureDir(path.join(backupDir, 'trees'));

  const dsiBackup = transaction.backupFile(paths.dsiPath(cwd), backupDir, 'document-summary-index.json');
  const movedTrees = [];

  // Move trees aside first: if the index write then fails, restoring is a copy
  // back rather than a re-ingestion.
  for (const t of targets) {
    const treePath = path.join(treesDir, t.tree_index);
    if (!fs.existsSync(treePath)) continue;
    const dest = path.join(backupDir, 'trees', t.tree_index);
    try {
      fs.copyFileSync(treePath, dest);
      fs.unlinkSync(treePath);
      movedTrees.push({ tree_index: t.tree_index, backup: dest });
    } catch (err) {
      restore();
      return {
        payload: { ok: false, message: `Could not move ${t.tree_index} aside: ${err.message}. Nothing was removed.`, rolled_back: true },
        exitCode: cli.EXIT_FAILED,
      };
    }
  }

  function restore() {
    for (const m of movedTrees) {
      try { if (fs.existsSync(m.backup)) fs.copyFileSync(m.backup, path.join(treesDir, m.tree_index)); } catch (_) {}
    }
    if (dsiBackup && fs.existsSync(dsiBackup)) {
      try { transaction.atomicWrite(paths.dsiPath(cwd), fs.readFileSync(dsiBackup)); } catch (_) {}
    }
  }

  try {
    transaction.atomicWrite(paths.dsiPath(cwd), JSON.stringify(nextIndex, null, 2) + '\n');
  } catch (err) {
    restore();
    return {
      payload: { ok: false, message: `Routing index could not be written: ${err.message}. Everything was restored.`, rolled_back: true },
      exitCode: cli.EXIT_FAILED,
    };
  }

  // Verify against what is actually on disk.
  const problems = [];
  try {
    const published = JSON.parse(fs.readFileSync(paths.dsiPath(cwd), 'utf8'));
    const stillPresent = dsi.leafFileSet(published);
    for (const t of targets) if (stillPresent.has(t.file)) problems.push(`${t.file} is still present in the published routing index.`);
    const recheck = validate.validateIndex(published, { hierarchyFields: hierarchy, baseSchema });
    if (!recheck.ok) problems.push(`published routing index failed validation (${recheck.errors.length} error(s))`);
  } catch (err) {
    problems.push(`published routing index could not be re-read: ${err.message}`);
  }

  if (problems.length) {
    restore();
    return {
      payload: { ok: false, message: `Verification failed: ${problems.join('; ')}. Everything was restored.`, rolled_back: true, problems },
      exitCode: cli.EXIT_FAILED,
    };
  }

  return {
    payload: {
      ok: true,
      removed: targets,
      not_found: notFound,
      trees_moved_to_backup: movedTrees.map(m => paths.toPosix(m.backup)),
      backup_dir: paths.toPosix(backupDir),
      remaining_leaves: check.leaves,
      note: 'Tree files were moved to the backup directory, not deleted. Remove that directory once you are satisfied.',
    },
    exitCode: cli.EXIT_OK,
  };
}

cli.run(main);
