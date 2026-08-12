#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// build-semantic-queue.js — turn skeleton trees into bounded work batches.
//
//   node build-semantic-queue.js --tree <path> [--tree <path> ...]
//                                --out-dir <dir> [--cwd <vault>] [--run-id <id>]
//
// Each batch is a self-contained JSON file: read it, produce the matching
// results file, done. No filesystem walking, no index access, no structural
// decisions. That is what makes a "worker" portable — a subagent on Claude,
// whatever Codex offers, or the orchestrator itself running them in sequence.
//
// Every task carries its document's full heading outline and its siblings'
// headings alongside the node's own content. Summarizing a node blind to what
// surrounds it is what produces the generic, interchangeable summaries the
// quality rules then reject; supplying the outline costs almost nothing and is
// what makes the distinctness requirements satisfiable rather than adversarial.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');

const MAX_TASK_CONTENT_CHARS = 12000;
const ROOT_EXCERPT_CHARS = 2500;

function flattenOutline(tree) {
  const outline = [];
  (function walk(nodes, ancestors) {
    for (const node of nodes || []) {
      const headingPath = ancestors.concat([node.heading]);
      outline.push({
        node_id: node.node_id,
        heading: node.heading,
        heading_path: headingPath,
        level: node.level,
        lines: node.content_ref ? node.content_ref.lines : null,
        is_leaf: (node.children || []).length === 0,
      });
      walk(node.children, headingPath);
    }
  })(tree.children, []);
  return outline;
}

function siblingHeadingsFor(tree) {
  // node_id -> the headings of its siblings, so a summary can be written to be
  // distinguishable from exactly the nodes it will be compared against.
  const map = new Map();
  (function walk(nodes) {
    const headings = (nodes || []).map(n => n.heading);
    (nodes || []).forEach((n, i) => {
      map.set(n.node_id, headings.filter((_, j) => j !== i));
      walk(n.children);
    });
  })(tree.children);
  return map;
}

function sliceLines(lines, range) {
  if (!range) return '';
  const text = lines.slice(range[0] - 1, range[1]).join('\n');
  if (text.length <= MAX_TASK_CONTENT_CHARS) return text;
  return text.slice(0, MAX_TASK_CONTENT_CHARS) + '\n\n[content truncated for length]';
}

const INSTRUCTIONS = {
  node_summary: [
    'Describe what a reader would retrieve from this node specifically.',
    'Name the concrete subjects, entities, operations, configuration keys, commands, protocols, figures, or constraints that actually appear in the supplied content.',
    'Add information the heading does not already convey.',
    'Make it distinguishable from the sibling headings listed alongside the task.',
    'Never state anything the supplied content does not support.',
  ],
  root_summary: [
    'Identify the document type, the product or entity it concerns, its purpose, and its principal topics.',
    'Use the full outline supplied with the document, not only the excerpt.',
    'Make it distinguishable from the other documents in this batch.',
  ],
  forbidden: [
    'Do not emit any field other than those named in output_schema.',
    'Do not restate the heading.',
    'Do not use filler openings such as "Documentation covering", "This section discusses", or "This document contains information about".',
  ],
};

const OUTPUT_SCHEMA = {
  batch_id: 'string — copy from the batch file',
  results: [
    {
      task_id: 'string — copy from the task',
      summary: 'string — the summary, within the word bounds given in limits',
      topics: ['string — 3 to 6 specific topics; required on root tasks, optional on node tasks'],
      metadata: 'object — root tasks only; one key per entry in the task\'s required_metadata, value or null',
    },
  ],
};

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const config = configLib.load(cwd);
  const limits = config.ingestion_quality;
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);

  const treeArgs = [].concat(args.tree || []).filter(Boolean);
  if (args['tree-dir']) {
    const dir = path.resolve(cwd, String(args['tree-dir']));
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) treeArgs.push(path.join(dir, f));
    }
  }
  if (treeArgs.length === 0) {
    throw cli.fail('usage', 'Usage: build-semantic-queue.js --tree <path> [--tree <path> ...] --out-dir <dir>');
  }
  if (!args['out-dir']) {
    throw cli.fail('usage', 'build-semantic-queue.js requires --out-dir.');
  }
  const outDir = path.resolve(cwd, String(args['out-dir']));
  paths.ensureDir(outDir);

  // Build every task first, then pack. Packing is a separate concern from
  // deciding what work exists.
  const documents = new Map();
  const allTasks = [];

  for (const treePathRaw of treeArgs) {
    const treePath = path.resolve(cwd, String(treePathRaw));
    const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
    const sourcePath = path.join(ingestionDir, tree.file);
    if (!fs.existsSync(sourcePath)) {
      throw cli.fail('source_missing', `Source file for ${tree.file} not found at ${sourcePath}.`);
    }
    const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r\n|\r|\n/);
    const outline = flattenOutline(tree);
    const siblings = siblingHeadingsFor(tree);
    const stem = paths.treeStem(tree.file);

    documents.set(tree.file, {
      file: tree.file,
      doc_type: tree.doc_type,
      tree_index: paths.treeFilename(tree.file),
      total_lines: tree.source_fingerprint ? tree.source_fingerprint.line_count : sourceLines.length,
      outline,
    });

    // One task per node that needs a summary — every node, leaf or not.
    for (const entry of outline) {
      const contentRange = entry.lines || rangeOfSubtree(tree, entry.node_id);
      allTasks.push({
        file: tree.file,
        task: {
          task_id: `${stem}:${entry.node_id}`,
          kind: 'node',
          node_id: entry.node_id,
          heading: entry.heading,
          heading_path: entry.heading_path,
          level: entry.level,
          lines: contentRange,
          sibling_headings: siblings.get(entry.node_id) || [],
          content: sliceLines(sourceLines, contentRange),
        },
      });
    }

    // The document-level summary, given the outline plus an opening excerpt.
    // The root task also carries the doc type's metadata schema, so extension
    // fields are extracted once, here, rather than in a separate pass.
    const excerpt = sourceLines.join('\n').slice(0, ROOT_EXCERPT_CHARS);
    const schemaFields = (config.doc_types.schemas && config.doc_types.schemas[tree.doc_type]) || [];
    allTasks.push({
      file: tree.file,
      task: {
        task_id: `${stem}:__root__`,
        kind: 'root',
        node_id: null,
        heading: tree.file,
        heading_path: [],
        lines: null,
        sibling_headings: [],
        required_metadata: schemaFields,
        metadata_rule: schemaFields.length
          ? 'Extract each listed field from the document. Set a field to null rather than guessing when the document does not state it.'
          : 'This doc type defines no extension fields.',
        content: excerpt,
      },
    });
  }

  // Greedy packing within both the node-count and character budgets.
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const item of allTasks) {
    const size = (item.task.content || '').length;
    const wouldExceed =
      current.length >= limits.max_nodes_per_semantic_batch ||
      (current.length > 0 && currentChars + size > limits.max_content_characters_per_semantic_batch);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += size;
  }
  if (current.length) batches.push(current);

  const runId = args['run-id'] ? String(args['run-id']) : path.basename(outDir);
  const written = [];

  batches.forEach((items, i) => {
    const batchId = `batch-${String(i + 1).padStart(3, '0')}`;
    const filesInBatch = Array.from(new Set(items.map(it => it.file)));
    const payload = {
      batch_id: batchId,
      run_id: runId,
      limits: {
        node_summary_words: [limits.node_summary_min_words, limits.node_summary_max_words],
        root_summary_words: [limits.root_summary_min_words, limits.root_summary_max_words],
      },
      instructions: INSTRUCTIONS,
      output_schema: OUTPUT_SCHEMA,
      documents: filesInBatch.map(f => {
        const doc = documents.get(f);
        return {
          file: doc.file,
          doc_type: doc.doc_type,
          total_lines: doc.total_lines,
          outline: doc.outline.map(o => ({ node_id: o.node_id, heading_path: o.heading_path, level: o.level })),
          tasks: items.filter(it => it.file === f).map(it => it.task),
        };
      }),
    };
    const file = path.join(outDir, `${batchId}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    written.push({ batch_id: batchId, path: paths.toPosix(file), tasks: items.length, documents: filesInBatch.length });
  });

  return {
    payload: {
      ok: true,
      run_id: runId,
      out_dir: paths.toPosix(outDir),
      documents: documents.size,
      tasks: allTasks.length,
      batches: written,
    },
    exitCode: cli.EXIT_OK,
  };
}

// A non-leaf node has no content_ref of its own; its summary is written from
// the span its subtree covers.
function rangeOfSubtree(tree, nodeId) {
  let found = null;
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.node_id === nodeId) { found = node; return; }
      walk(node.children);
      if (found) return;
    }
  })(tree.children);
  if (!found) return null;

  let min = Infinity;
  let max = -Infinity;
  (function walk(node) {
    if (node.content_ref) {
      min = Math.min(min, node.content_ref.lines[0]);
      max = Math.max(max, node.content_ref.lines[1]);
    }
    for (const c of node.children || []) walk(c);
  })(found);
  return min === Infinity ? null : [min, max];
}

cli.run(main);
