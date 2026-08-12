#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// build-tree.js — deterministic tree skeleton for one source document.
//
//   node build-tree.js --source <path> [--doc-type <type>] [--out <path>]
//                      [--cwd <vault root>] [--stdout]
//
// Emits a complete tree index with every `summary` and `root_summary` set to
// null, plus a validation report. No model is involved and none may be: this
// output is the structural contract the semantic stage is allowed to fill in
// but never to reshape.
//
// Exit 0 = built and valid. Exit 1 = built but invalid (report says why).
// Exit 2 = could not build at all.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const fingerprintLib = require('./lib/fingerprint');
const markdown = require('./lib/markdown');
const treeLib = require('./lib/tree');
const validate = require('./lib/validate');

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();

  const source = args.source || args._[0];
  if (!source) {
    throw cli.fail('usage', 'Usage: build-tree.js --source <path> [--doc-type <type>] [--out <path>]');
  }

  const config = configLib.load(cwd);
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);
  const absSource = path.resolve(cwd, String(source));

  if (!fs.existsSync(absSource)) {
    throw cli.fail('source_missing', `Source file not found: ${absSource}`);
  }
  // query later rebuilds source paths as ingestion_directory + file, so a path
  // outside that root would produce a tree nothing can ever read back.
  if (!paths.isInside(ingestionDir, absSource)) {
    throw cli.fail('outside_ingestion_dir',
      `${absSource} is outside the configured ingestion directory (${ingestionDir}). Only files under it can be indexed.`);
  }

  const relativePath = paths.relativeFrom(ingestionDir, absSource);
  const docType = args['doc-type'] ? String(args['doc-type']) : configLib.docTypeFor(config, relativePath);
  if (!docType) {
    throw cli.fail('doc_type_unresolved',
      `No doc type mapping matches \`${relativePath}\`. Pass --doc-type explicitly or add a mapping via config-update.`);
  }

  const content = fs.readFileSync(absSource, 'utf8');
  const fingerprint = fingerprintLib.ofContent(content);
  const parsed = markdown.parse(content);

  if (config.source && config.source.page_numbers_in_citations && parsed.pageMarkers.length === 0) {
    throw cli.fail('no_page_markers',
      `Page numbers are configured but no page markers were found in ${relativePath}. Check the file, or disable page numbers via config-update.`);
  }

  const stem = paths.treeStem(relativePath);
  const built = treeLib.buildSkeleton({
    parsed,
    relativePath,
    stem,
    docType,
    fingerprint,
    config,
  });

  const validation = validate.validateTree(built.tree, {
    wantPages: !!(config.source && config.source.page_numbers_in_citations),
    parsed,
  });

  let outPath = null;
  if (args.out) {
    outPath = path.resolve(cwd, String(args.out));
    paths.ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify(built.tree, null, 2) + '\n');
  }

  const payload = {
    ok: validation.ok,
    file: relativePath,
    doc_type: docType,
    tree_index: paths.treeFilename(relativePath),
    out: outPath,
    stats: built.stats,
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      coverage: validation.coverage,
    },
  };
  if (args.stdout || !outPath) payload.tree = built.tree;

  return { payload, exitCode: validation.ok ? cli.EXIT_OK : cli.EXIT_FAILED };
}

cli.run(main);
