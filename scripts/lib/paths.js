'use strict';

const fs = require('fs');
const path = require('path');
const { fail } = require('./cli');

// ---------------------------------------------------------------------------
// `.index/` is always resolved from the current working directory — the vault
// root a runtime was launched in — never from where these scripts are
// installed. Global installs make every vault independent, so a script that
// resolved relative to its own location would read the wrong vault entirely.
// ---------------------------------------------------------------------------

function indexDir(cwd) {
  return path.join(cwd || process.cwd(), '.index');
}

function configPath(cwd) {
  return path.join(indexDir(cwd), 'config.json');
}

function dsiPath(cwd) {
  return path.join(indexDir(cwd), 'document-summary-index.json');
}

function treesDir(cwd) {
  return path.join(indexDir(cwd), 'trees');
}

function stagingDir(cwd) {
  return path.join(indexDir(cwd), 'staging');
}

function runDir(runId, cwd) {
  return path.join(stagingDir(cwd), runId);
}

// The tree index filename for a source file, derived from its path relative to
// vault.ingestion_directory: separators become underscores, `.md` becomes
// `.json`. `financial/2023/apple-10k.md` -> `financial_2023_apple-10k.json`.
function treeFilename(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/\//g, '_').replace(/\.md$/i, '') + '.json';
}

// The filename stem used to prefix every node_id in a tree.
function treeStem(relativePath) {
  return treeFilename(relativePath).replace(/\.json$/, '');
}

// Normalizes to forward slashes so a path computed on Windows and one computed
// on POSIX produce identical index content for the same vault.
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// True when `child` is the same as, or nested inside, `parent`. Used to enforce
// that every ingested path falls under vault.ingestion_directory — query later
// reconstructs source paths as ingestion_directory + file, so a path outside it
// breaks retrieval silently.
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function relativeFrom(parent, child) {
  return toPosix(path.relative(path.resolve(parent), path.resolve(child)));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function requireIndex(cwd) {
  const dir = indexDir(cwd);
  if (!fs.existsSync(dir)) {
    throw fail('no_index', `No index found in ${path.resolve(cwd || process.cwd())}. Run the onboard skill first.`);
  }
  return dir;
}

module.exports = {
  indexDir,
  configPath,
  dsiPath,
  treesDir,
  stagingDir,
  runDir,
  treeFilename,
  treeStem,
  toPosix,
  isInside,
  relativeFrom,
  ensureDir,
  requireIndex,
};
