#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// docSearch selftest
//
// Proves, from inside whichever runtime invoked it, that:
//   1. the skill's patched script path actually resolved to this file
//   2. Node is present and new enough
//   3. the shared lib modules load
//   4. the vault's `.index/config.json` is readable and parses (when onboarded)
//   5. this process can create, write, read back, and delete a file in the
//      vault — the capability every later stage depends on for staging
//
// Every assumption the pipeline rests on becomes one observable pass/fail here,
// before any parser work depends on it. Run this first on every install target.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('./lib/cli');

const MIN_NODE_MAJOR = 18;

function check(name, fn) {
  try {
    const detail = fn();
    return { check: name, ok: true, detail: detail === undefined ? null : detail };
  } catch (err) {
    return { check: name, ok: false, detail: err && err.message ? err.message : String(err) };
  }
}

function main() {
  const cwd = process.cwd();
  const results = [];

  results.push(check('script_path_resolved', () => path.resolve(__filename)));

  results.push(check('node_version', () => {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major < MIN_NODE_MAJOR) {
      throw new Error(`Node ${process.versions.node} is older than the required ${MIN_NODE_MAJOR}.`);
    }
    return process.versions.node;
  }));

  results.push(check('platform', () => `${os.platform()} ${os.release()}`));
  results.push(check('working_directory', () => cwd));

  results.push(check('lib_modules_load', () => {
    const paths = require('./lib/paths');
    const fingerprint = require('./lib/fingerprint');
    require('./lib/config');
    // Exercise them rather than merely requiring them, so a module that loads
    // but is broken still fails here.
    const fp = fingerprint.ofContent('a\nb\n');
    if (fp.line_count !== 3 || fp.sha256.length !== 64) throw new Error('fingerprint module returned unexpected output');
    if (paths.treeFilename('a/b/c.md') !== 'a_b_c.json') throw new Error('paths module returned unexpected output');
    return 'paths, fingerprint, config';
  }));

  const paths = require('./lib/paths');
  const indexExists = fs.existsSync(paths.indexDir(cwd));

  results.push(check('index_directory', () => {
    if (!indexExists) return 'absent — vault not onboarded yet (not an error for this test)';
    return paths.indexDir(cwd);
  }));

  results.push(check('config_readable', () => {
    if (!indexExists) return 'skipped — no .index/ present';
    const config = require('./lib/config').load(cwd);
    return `schema_version ${config.schema_version}, ingestion_directory ${config.vault.ingestion_directory}`;
  }));

  // The write test targets `.index/staging/` when the vault is onboarded,
  // since that is the exact directory the transaction engine will use. Before
  // onboarding it falls back to the vault root, which still proves the process
  // can write where it will need to.
  results.push(check('write_and_delete', () => {
    const target = indexExists
      ? path.join(paths.stagingDir(cwd), `.selftest-${process.pid}`)
      : path.join(cwd, `.docsearch-selftest-${process.pid}`);
    const marker = `docsearch-selftest ${Date.now()}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, marker);
    const readBack = fs.readFileSync(target, 'utf8');
    if (readBack !== marker) throw new Error('file written but read back with different content');
    fs.unlinkSync(target);
    if (fs.existsSync(target)) throw new Error('file could not be deleted');
    // Leave no trace: remove staging/ if this test is what created it.
    if (indexExists) {
      try {
        if (fs.readdirSync(paths.stagingDir(cwd)).length === 0) fs.rmdirSync(paths.stagingDir(cwd));
      } catch (_) { /* a concurrent run may legitimately be using it */ }
    }
    return target;
  }));

  const failures = results.filter(r => !r.ok);
  const payload = {
    ok: failures.length === 0,
    checks: results,
    failed: failures.length,
    summary: failures.length === 0
      ? 'All selftest checks passed. Scripts are reachable and the vault is writable.'
      : `${failures.length} check(s) failed: ${failures.map(f => f.check).join(', ')}`,
  };

  return { payload, exitCode: failures.length === 0 ? cli.EXIT_OK : cli.EXIT_FAILED };
}

cli.run(main);
