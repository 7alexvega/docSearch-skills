#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// sync-plan.js — three-way diff between the vault and the index.
//
//   node sync-plan.js [--cwd <vault>]
//
// Read-only. Produces the plan; the sync skill confirms it with the user and
// then drives ingest / modify / remove. Splitting the diff from the action is
// what lets a user see exactly what is about to change before anything does.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

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
      } else if (/\.md$/i.test(entry.name)) out.push(full);
    }
  })(dir);
  return out;
}

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);

  if (!fs.existsSync(ingestionDir)) {
    throw cli.fail('no_ingestion_dir', `The configured ingestion directory does not exist: ${ingestionDir}`);
  }

  const index = dsi.loadOrEmpty(cwd);
  const leaves = dsi.collectLeaves(index);
  const leafByFile = new Map(leaves.map(l => [l.file, l]));
  const treesDir = paths.treesDir(cwd);

  const onDisk = listMarkdown(ingestionDir).map(abs => paths.relativeFrom(ingestionDir, abs));
  const onDiskSet = new Set(onDisk);

  const toIngest = [];
  const toModify = [];
  const toRemove = [];
  const unchanged = [];
  const excluded = [];
  const classificationChanges = [];

  for (const relativePath of onDisk) {
    const abs = path.join(ingestionDir, relativePath);
    const content = fs.readFileSync(abs, 'utf8');
    const fingerprint = fingerprintLib.ofContent(content);
    const parsed = markdown.parse(content);
    const classification = classifyLib.classify(parsed, relativePath, config);
    const leaf = leafByFile.get(relativePath);

    if (!leaf) {
      if (classification.indexed) {
        toIngest.push({ file: relativePath, classification: classification.classification, line_count: fingerprint.line_count });
      } else {
        excluded.push({ file: relativePath, classification: classification.classification, reason: classification.reason });
      }
      continue;
    }

    // A document already indexed whose source is no longer substantive should
    // be surfaced explicitly rather than quietly re-ingested as-is.
    if (!classification.indexed) {
      classificationChanges.push({
        file: relativePath,
        now: classification.classification,
        reason: classification.reason,
        action: 'remove',
      });
      toRemove.push({ file: relativePath, reason: `Reclassified as ${classification.classification}` });
      continue;
    }

    const treePath = path.join(treesDir, leaf.tree_index || paths.treeFilename(relativePath));
    let recorded = null;
    if (fs.existsSync(treePath)) {
      try { recorded = JSON.parse(fs.readFileSync(treePath, 'utf8')).source_fingerprint || null; } catch (_) { recorded = null; }
    }

    if (!fs.existsSync(treePath)) {
      toModify.push({ file: relativePath, reason: 'Tree index is missing while the routing entry still exists.' });
    } else if (!recorded) {
      unchanged.push({ file: relativePath, staleness: 'unknown (no fingerprint recorded)' });
    } else if (!fingerprintLib.equal(recorded, fingerprint)) {
      toModify.push({
        file: relativePath,
        reason: 'Source has changed since it was indexed.',
        recorded,
        current: fingerprint,
      });
    } else {
      unchanged.push({ file: relativePath, staleness: 'current' });
    }
  }

  for (const leaf of leaves) {
    if (!onDiskSet.has(leaf.file)) {
      toRemove.push({ file: leaf.file, reason: 'Indexed but the source no longer exists on disk.' });
    }
  }

  return {
    payload: {
      ok: true,
      ingestion_directory: paths.toPosix(ingestionDir),
      totals: {
        on_disk: onDisk.length,
        indexed: leaves.length,
        to_ingest: toIngest.length,
        to_modify: toModify.length,
        to_remove: toRemove.length,
        unchanged: unchanged.length,
        excluded: excluded.length,
      },
      to_ingest: toIngest,
      to_modify: toModify,
      to_remove: toRemove,
      classification_changes: classificationChanges,
      excluded,
      unchanged,
    },
    exitCode: cli.EXIT_OK,
  };
}

cli.run(main);
