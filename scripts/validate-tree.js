#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// validate-tree.js — check an existing tree index against the shared rules.
//
//   node validate-tree.js --tree <path> [--source <path>] [--cwd <vault root>]
//   node validate-tree.js --all [--cwd <vault root>]
//
// With --source (or --all, which resolves sources from config) it additionally
// re-parses the document and checks coverage and fingerprint freshness. Without
// one it checks structure only.
//
// This is the same module doctor, ingestion, modify, and sync call. There is no
// second implementation of these rules anywhere.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const fingerprintLib = require('./lib/fingerprint');
const markdown = require('./lib/markdown');
const validate = require('./lib/validate');

function readTree(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `could not be read: ${err.message}` };
  }
  if (raw.trim() === '') return { error: 'is empty (0 bytes of content)' };
  try {
    return { tree: JSON.parse(raw) };
  } catch (err) {
    return { error: `is not valid JSON: ${err.message}` };
  }
}

function checkOne(treePath, config, cwd, explicitSource) {
  const name = path.basename(treePath);
  const { tree, error } = readTree(treePath);
  if (error) {
    return { tree_index: name, ok: false, errors: [{ code: 'unreadable_tree', message: `${name} ${error}` }], warnings: [], coverage: null };
  }

  const opts = { wantPages: !!(config.source && config.source.page_numbers_in_citations) };

  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);
  const sourcePath = explicitSource
    ? path.resolve(cwd, explicitSource)
    : (tree.file ? path.join(ingestionDir, tree.file) : null);

  if (sourcePath && fs.existsSync(sourcePath)) {
    const content = fs.readFileSync(sourcePath, 'utf8');
    opts.parsed = markdown.parse(content);
    opts.fingerprint = fingerprintLib.ofContent(content);
  } else if (sourcePath) {
    const result = validate.validateTree(tree, opts);
    result.warnings.push({
      code: 'source_missing',
      message: `Source file not found at ${sourcePath}; coverage and staleness could not be checked.`,
    });
    return Object.assign({ tree_index: name }, result);
  }

  return Object.assign({ tree_index: name }, validate.validateTree(tree, opts));
}

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);

  let targets = [];
  if (args.all) {
    const dir = paths.treesDir(cwd);
    if (!fs.existsSync(dir)) throw cli.fail('no_trees', `No tree directory found at ${dir}.`);
    targets = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f));
  } else {
    const tree = args.tree || args._[0];
    if (!tree) throw cli.fail('usage', 'Usage: validate-tree.js --tree <path> [--source <path>]  |  validate-tree.js --all');
    targets = [path.resolve(cwd, String(tree))];
  }

  const results = targets.map(t => checkOne(t, config, cwd, args.source ? String(args.source) : null));
  const failed = results.filter(r => !r.ok);

  return {
    payload: {
      ok: failed.length === 0,
      checked: results.length,
      failed: failed.length,
      total_errors: results.reduce((n, r) => n + r.errors.length, 0),
      results,
    },
    exitCode: failed.length === 0 ? cli.EXIT_OK : cli.EXIT_FAILED,
  };
}

cli.run(main);
