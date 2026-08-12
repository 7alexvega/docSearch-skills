#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// scan-vault.js — discovery and classification. Stage 1 and 2 of the pipeline.
//
//   node scan-vault.js --input <file|dir> [--input <another>] [--cwd <vault>]
//   node scan-vault.js --all [--cwd <vault>]        # everything under the vault
//
// Produces the deterministic file list every later stage works from: absolute
// and relative paths, tree filenames, fingerprints, whether each document is
// already indexed, and what each source actually is (substantive, redirect,
// placeholder, navigation-only).
//
// No model participates in this stage. Writes nothing — this is also the
// dry-run reporting surface, safe to run against any vault at any time.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const fingerprintLib = require('./lib/fingerprint');
const markdown = require('./lib/markdown');
const classifyLib = require('./lib/classify');
const dsi = require('./lib/dsi');

function listMarkdown(dir) {
  const out = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.md$/i.test(entry.name)) {
        out.push(full);
      }
    }
  })(dir);
  return out;
}

function makeRunId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);

  if (!fs.existsSync(ingestionDir)) {
    throw cli.fail('no_ingestion_dir', `The configured ingestion directory does not exist: ${ingestionDir}`);
  }

  // Inputs may arrive as repeated --input flags, a comma-separated list, or
  // bare positional arguments.
  let rawInputs = [];
  if (args.all) {
    rawInputs = [ingestionDir];
  } else {
    const provided = [].concat(args.input || [], args._ || []).filter(Boolean);
    rawInputs = provided.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  }
  if (rawInputs.length === 0) {
    throw cli.fail('usage', 'Usage: scan-vault.js --input <file|dir> [--input <another>]  |  scan-vault.js --all');
  }

  const absFiles = [];
  const notFound = [];
  const outside = [];

  for (const input of rawInputs) {
    const abs = path.resolve(cwd, input);
    if (!fs.existsSync(abs)) { notFound.push(input); continue; }
    if (!paths.isInside(ingestionDir, abs)) { outside.push(input); continue; }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) absFiles.push(...listMarkdown(abs));
    else if (/\.md$/i.test(abs)) absFiles.push(abs);
    else notFound.push(`${input} (not a Markdown file)`);
  }

  if (outside.length) {
    throw cli.fail('outside_ingestion_dir',
      `These inputs fall outside the configured ingestion directory (${ingestionDir}): ${outside.join(', ')}. Only files under it can be indexed.`);
  }

  // Deterministic order: identical input always produces an identical manifest.
  const unique = Array.from(new Set(absFiles)).sort();

  const treesDir = paths.treesDir(cwd);
  const existingTrees = fs.existsSync(treesDir)
    ? new Set(fs.readdirSync(treesDir).filter(f => f.endsWith('.json')))
    : new Set();
  const indexedFiles = fs.existsSync(paths.dsiPath(cwd)) ? dsi.leafFileSet(dsi.load(cwd)) : new Set();

  const files = unique.map(abs => {
    const relativePath = paths.relativeFrom(ingestionDir, abs);
    const content = fs.readFileSync(abs, 'utf8');
    const fingerprint = fingerprintLib.ofContent(content);
    const parsed = markdown.parse(content);
    const classification = classifyLib.classify(parsed, relativePath, config);
    const treeIndex = paths.treeFilename(relativePath);

    return {
      absolute_path: paths.toPosix(abs),
      relative_path: relativePath,
      tree_index: treeIndex,
      doc_type: configLib.docTypeFor(config, relativePath),
      line_count: fingerprint.line_count,
      sha256: fingerprint.sha256,
      headings: parsed.headings.length,
      existing_tree: existingTrees.has(treeIndex),
      existing_leaf: indexedFiles.has(relativePath),
      classification: classification.classification,
      classification_reason: classification.reason,
      alias_target: classification.alias_target,
      indexed: classification.indexed,
      metrics: classification.metrics,
    };
  });

  const byClassification = {};
  for (const c of classifyLib.CLASSIFICATIONS) byClassification[c] = 0;
  for (const f of files) byClassification[f.classification]++;

  const unmapped = files.filter(f => f.indexed && !f.doc_type).map(f => f.relative_path);
  const aliases = files
    .filter(f => f.classification === 'redirect' && f.alias_target)
    .map(f => ({ from: f.relative_path, to: f.alias_target, resolved: unique.some(u => paths.relativeFrom(ingestionDir, u) === f.alias_target) }));

  return {
    payload: {
      ok: true,
      run_id: args['run-id'] ? String(args['run-id']) : makeRunId(),
      ingestion_directory: paths.toPosix(ingestionDir),
      scanned: files.length,
      not_found: notFound,
      summary: {
        by_classification: byClassification,
        to_ingest: files.filter(f => f.indexed && !f.existing_tree).length,
        already_indexed: files.filter(f => f.existing_leaf).length,
        excluded: files.filter(f => !f.indexed).length,
        unmapped_doc_type: unmapped,
        aliases,
      },
      files,
    },
    exitCode: cli.EXIT_OK,
  };
}

cli.run(main);
