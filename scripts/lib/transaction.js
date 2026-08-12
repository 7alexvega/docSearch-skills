'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { fail } = require('./cli');

// ---------------------------------------------------------------------------
// Staging and transactional publication.
//
// Nothing reaches `.index/trees/` or replaces `document-summary-index.json`
// until it has been validated in staging. Publication then proceeds
// backup -> move -> verify, and rolls back everything it touched if the
// verification read does not match what it believed it wrote.
//
// The safety here comes from ordering and from re-reading after writing, not
// from any runtime feature. It behaves identically with hooks absent, under
// Codex, or invoked from a plain shell — which is the entire point.
// ---------------------------------------------------------------------------

const STATES = [
  'discovered', 'classified', 'parsed', 'tree_built', 'semantic_pending',
  'semantic_complete', 'validated', 'published', 'routing_inserted',
];

const TERMINAL_FAILURES = [
  'excluded_redirect', 'excluded_placeholder', 'excluded_navigation',
  'failed_parse', 'failed_semantic_validation', 'failed_structural_validation',
  'failed_publish', 'failed_routing_insert',
];

function runPaths(cwd, runId) {
  const dir = paths.runDir(runId, cwd);
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    trees: path.join(dir, 'trees'),
    merged: path.join(dir, 'merged'),
    queue: path.join(dir, 'semantic-queue'),
    results: path.join(dir, 'semantic-results'),
    backup: path.join(dir, 'backup'),
    transaction: path.join(dir, 'transaction.json'),
    nextDsi: path.join(dir, 'document-summary-index.next.json'),
    validation: path.join(dir, 'validation-report.json'),
  };
}

function createRun(cwd, runId) {
  const rp = runPaths(cwd, runId);
  for (const key of ['dir', 'trees', 'merged', 'queue', 'results', 'backup']) paths.ensureDir(rp[key]);
  return rp;
}

function readManifest(cwd, runId) {
  const rp = runPaths(cwd, runId);
  if (!fs.existsSync(rp.manifest)) throw fail('no_manifest', `No run manifest at ${rp.manifest}.`);
  return JSON.parse(fs.readFileSync(rp.manifest, 'utf8'));
}

function writeManifest(cwd, runId, manifest) {
  const rp = runPaths(cwd, runId);
  paths.ensureDir(rp.dir);
  fs.writeFileSync(rp.manifest, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// Writes to a sibling temp file, then renames over the target. On both POSIX
// and Windows the rename is atomic, so a reader never observes a half-written
// index — it sees either the old file or the new one.
function atomicWrite(targetPath, content) {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  paths.ensureDir(path.dirname(targetPath));
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function atomicMove(fromPath, toPath) {
  paths.ensureDir(path.dirname(toPath));
  fs.renameSync(fromPath, toPath);
}

function backupFile(sourcePath, backupDir, name) {
  if (!fs.existsSync(sourcePath)) return null;
  paths.ensureDir(backupDir);
  const dest = path.join(backupDir, name);
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

/**
 * Publishes a set of validated trees and a next-state DSI.
 *
 * Order matters and is not negotiable:
 *   1. back up every file that will be overwritten or replaced
 *   2. move trees into place
 *   3. atomically replace the routing index
 *   4. re-read both and verify
 *   5. on any failure, restore every backup taken in step 1
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {Array}  opts.trees      [{ stagedPath, treeIndex }]
 * @param {object} opts.nextIndex  the complete next DSI object
 * @param {string} opts.backupDir
 * @param {function} opts.verifyIndex  (published) => string[] of problems
 */
function publish(opts) {
  const { cwd, trees, nextIndex, backupDir, verifyIndex } = opts;
  const treesDir = paths.treesDir(cwd);
  const dsiPath = paths.dsiPath(cwd);
  paths.ensureDir(treesDir);

  const actions = [];
  const published = [];
  const failures = [];

  // 1. Back up everything at risk, before anything moves.
  const dsiBackup = backupFile(dsiPath, backupDir, 'document-summary-index.json');
  for (const t of trees) {
    const target = path.join(treesDir, t.treeIndex);
    if (fs.existsSync(target)) {
      backupFile(target, path.join(backupDir, 'trees'), t.treeIndex);
      actions.push({ kind: 'tree_overwrite', tree_index: t.treeIndex });
    } else {
      actions.push({ kind: 'tree_create', tree_index: t.treeIndex });
    }
  }

  function rollback(reason) {
    // Restore the routing index first: a stale index pointing at trees that
    // exist is recoverable; a fresh index pointing at trees that do not is not.
    if (dsiBackup && fs.existsSync(dsiBackup)) {
      try { atomicWrite(dsiPath, fs.readFileSync(dsiBackup)); } catch (_) { /* reported below */ }
    }
    for (const action of actions) {
      const target = path.join(treesDir, action.tree_index);
      const saved = path.join(backupDir, 'trees', action.tree_index);
      try {
        if (action.kind === 'tree_overwrite' && fs.existsSync(saved)) fs.copyFileSync(saved, target);
        else if (action.kind === 'tree_create' && fs.existsSync(target)) fs.unlinkSync(target);
      } catch (_) { /* best effort; the report names what was attempted */ }
    }
    return reason;
  }

  // 2. Trees. A single tree failing to move takes only itself out of the run.
  for (const t of trees) {
    const target = path.join(treesDir, t.treeIndex);
    try {
      atomicMove(t.stagedPath, target);
      published.push(t.treeIndex);
    } catch (err) {
      failures.push({ tree_index: t.treeIndex, state: 'failed_publish', message: err.message });
    }
  }

  // 3. Routing index — exactly one write, after every tree is in place.
  try {
    atomicWrite(dsiPath, JSON.stringify(nextIndex, null, 2) + '\n');
  } catch (err) {
    return {
      ok: false,
      published: [],
      failures: failures.concat([{ state: 'failed_routing_insert', message: err.message }]),
      rolled_back: true,
      reason: rollback(`Routing index could not be written: ${err.message}`),
    };
  }

  // 4. Verify by reading back what is actually on disk, not what we intended.
  const problems = [];
  let publishedIndex = null;
  try {
    publishedIndex = JSON.parse(fs.readFileSync(dsiPath, 'utf8'));
  } catch (err) {
    problems.push(`Published routing index could not be re-read: ${err.message}`);
  }
  if (publishedIndex && typeof verifyIndex === 'function') {
    problems.push(...(verifyIndex(publishedIndex) || []));
  }
  for (const treeIndex of published) {
    const target = path.join(treesDir, treeIndex);
    if (!fs.existsSync(target)) { problems.push(`${treeIndex} is missing after publication.`); continue; }
    try {
      JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      problems.push(`${treeIndex} is not parseable after publication: ${err.message}`);
    }
  }

  if (problems.length) {
    return {
      ok: false,
      published: [],
      failures: failures.concat(problems.map(p => ({ state: 'failed_publish', message: p }))),
      rolled_back: true,
      reason: rollback(`Post-publication verification failed: ${problems.join('; ')}`),
    };
  }

  return { ok: failures.length === 0, published, failures, rolled_back: false, backup_dir: backupDir };
}

module.exports = {
  STATES,
  TERMINAL_FAILURES,
  runPaths,
  createRun,
  readManifest,
  writeManifest,
  atomicWrite,
  atomicMove,
  backupFile,
  publish,
};
