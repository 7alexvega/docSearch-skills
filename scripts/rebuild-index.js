#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// rebuild-index.js — reconstruct the routing index from the trees on disk.
//
//   node rebuild-index.js [--cwd <vault>] [--dry-run]
//
// Recovery tool. Use it when the routing index is missing, unparseable, or has
// drifted out of step with `.index/trees/`. It never touches a tree: the trees
// are the source of truth here, and each one carries the routing payload it was
// published with, so the rebuild is lossless rather than a re-derivation.
//
// A tree written before `index_metadata` existed is rebuilt from what its root
// does carry, and every field that cannot be recovered is reported rather than
// guessed at.
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

  const treesDir = paths.treesDir(cwd);
  if (!fs.existsSync(treesDir)) {
    throw cli.fail('no_trees', `No trees directory at ${treesDir}. There is nothing to rebuild from.`);
  }

  const treeFiles = fs.readdirSync(treesDir).filter(f => f.endsWith('.json')).sort();
  if (!treeFiles.length) {
    throw cli.fail('no_trees', `${treesDir} contains no tree index files. There is nothing to rebuild from.`);
  }

  const nextIndex = dsi.emptyIndex();
  const rebuilt = [];
  const skipped = [];
  const incomplete = [];

  for (const f of treeFiles) {
    let tree;
    try {
      tree = JSON.parse(fs.readFileSync(path.join(treesDir, f), 'utf8'));
    } catch (err) {
      skipped.push({ tree_index: f, reason: `unparseable: ${err.message}` });
      continue;
    }
    if (!tree.file) {
      skipped.push({ tree_index: f, reason: 'tree root has no `file` field' });
      continue;
    }

    let leaf;
    const missing = [];
    if (tree.index_metadata && typeof tree.index_metadata === 'object') {
      leaf = Object.assign({}, tree.index_metadata);
    } else {
      // Pre-`index_metadata` tree: recover what the root actually carries and
      // report the rest as unrecovered rather than inventing values.
      leaf = {
        type: 'leaf',
        file: tree.file,
        doc_type: tree.doc_type || null,
        doc_group: configLib.docGroupFor(config, tree.doc_type) || null,
        topics: Array.isArray(tree.topics) ? tree.topics : [],
        date_added: null,
        summary: tree.root_summary || null,
        tree_index: f,
      };
      const schemaFields = (config.doc_types.schemas && config.doc_types.schemas[tree.doc_type]) || [];
      for (const field of schemaFields) leaf[field] = null;
      for (const field of [].concat(baseSchema, schemaFields)) {
        if (leaf[field] === null || leaf[field] === undefined) missing.push(field);
      }
    }

    leaf.type = 'leaf';
    leaf.tree_index = f;
    if (missing.length) incomplete.push({ file: tree.file, unrecovered: missing });

    const unknownFields = dsi.unknownFieldsFor(hierarchy, leaf);
    if (unknownFields.length) incomplete.push({ file: tree.file, placed_under_unknown: unknownFields });

    const parent = dsi.ensurePath(nextIndex, hierarchy, leaf);
    const lastField = hierarchy[hierarchy.length - 1];
    const leafNode = Object.assign({}, leaf, {
      field: lastField || null,
      value: lastField ? (leaf[lastField] === undefined || leaf[lastField] === null ? 'unknown' : leaf[lastField]) : null,
    });
    delete leafNode.children;
    parent.children = parent.children || [];
    parent.children.push(leafNode);
    rebuilt.push(tree.file);
  }

  const check = validate.validateIndex(nextIndex, {
    hierarchyFields: hierarchy,
    baseSchema,
    availableTrees: new Set(treeFiles),
  });

  if (args['dry-run']) {
    return {
      payload: {
        ok: check.ok,
        dry_run: true,
        would_rebuild: rebuilt.length,
        leaves: check.leaves,
        skipped,
        incomplete,
        errors: check.errors,
      },
      exitCode: check.ok ? cli.EXIT_OK : cli.EXIT_FAILED,
    };
  }

  if (!check.ok) {
    return {
      payload: {
        ok: false,
        stage: 'validation',
        message: 'The rebuilt routing index failed validation. Nothing was written.',
        errors: check.errors,
        skipped,
        incomplete,
      },
      exitCode: cli.EXIT_FAILED,
    };
  }

  const runId = args['run-id'] ? String(args['run-id']) : `rebuild-${Date.now()}`;
  const backupDir = path.join(paths.stagingDir(cwd), runId, 'backup');
  paths.ensureDir(backupDir);
  const backup = transaction.backupFile(paths.dsiPath(cwd), backupDir, 'document-summary-index.json');

  try {
    transaction.atomicWrite(paths.dsiPath(cwd), JSON.stringify(nextIndex, null, 2) + '\n');
    const published = JSON.parse(fs.readFileSync(paths.dsiPath(cwd), 'utf8'));
    const recheck = validate.validateIndex(published, { hierarchyFields: hierarchy, baseSchema });
    if (!recheck.ok) throw new Error(`published index failed validation (${recheck.errors.length} error(s))`);
  } catch (err) {
    if (backup && fs.existsSync(backup)) {
      try { transaction.atomicWrite(paths.dsiPath(cwd), fs.readFileSync(backup)); } catch (_) {}
    }
    return {
      payload: { ok: false, message: `Rebuild failed and was rolled back: ${err.message}`, rolled_back: true },
      exitCode: cli.EXIT_FAILED,
    };
  }

  return {
    payload: {
      ok: true,
      rebuilt: rebuilt.length,
      leaves: check.leaves,
      skipped,
      incomplete,
      backup: backup ? paths.toPosix(backup) : null,
      note: skipped.length || incomplete.length
        ? 'Some entries could not be fully recovered — see `skipped` and `incomplete`. Run modify on those documents to restore their metadata.'
        : 'Every routing entry was recovered from its tree.',
    },
    exitCode: cli.EXIT_OK,
  };
}

cli.run(main);
