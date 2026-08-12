#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// doctor.js — read-only health report for an index.
//
//   node doctor.js [--deep] [--quality] [--cwd <vault>]
//
// Default    routing index + a directory listing. Cheap, no tree parsing.
// --deep     parses every tree, revalidates it, confirms sources exist, and
//            checks staleness fingerprints.
// --quality  adds summary-quality metrics: generic rate, duplicate rate,
//            coverage distribution, cross-reference resolution.
//
// This calls the same validators ingestion and publication call. It never
// writes; every finding names the skill that fixes it.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const cli = require('./lib/cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const fingerprintLib = require('./lib/fingerprint');
const markdown = require('./lib/markdown');
const validate = require('./lib/validate');
const quality = require('./lib/quality');
const dsi = require('./lib/dsi');

function main() {
  const args = cli.parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const deep = !!args.deep;
  const wantQuality = !!args.quality;

  const config = configLib.load(cwd);
  const hierarchy = (config.doc_summary_index && config.doc_summary_index.hierarchy_fields) || [];
  const baseSchema = (config.doc_types && config.doc_types.base_schema) || [];
  const ingestionDir = path.resolve(cwd, config.vault.ingestion_directory);
  const treesDir = paths.treesDir(cwd);

  const findings = [];
  const finding = (severity, code, message, fix, extra) =>
    findings.push(Object.assign({ severity, code, message, fix: fix || null }, extra || {}));

  const treeFiles = fs.existsSync(treesDir)
    ? fs.readdirSync(treesDir).filter(f => f.endsWith('.json')).sort()
    : [];

  const dsiExists = fs.existsSync(paths.dsiPath(cwd));
  if (!dsiExists) {
    if (treeFiles.length) {
      finding('error', 'routing_index_missing',
        `document-summary-index.json is missing, but .index/trees/ contains ${treeFiles.length} tree index file(s). The routing layer is gone while document content still exists.`,
        'rebuild-summary (full rebuild)');
    } else {
      finding('info', 'empty_index',
        'No routing index and no tree indexes found. This looks like a freshly onboarded, empty vault.',
        'ingest');
    }
    return report(config, findings, { documents: 0, trees: treeFiles.length }, null, deep, wantQuality);
  }

  let index;
  try {
    index = dsi.load(cwd);
  } catch (err) {
    finding('error', 'routing_index_unparseable', err.message, 'rebuild-summary (full rebuild)');
    return report(config, findings, { documents: 0, trees: treeFiles.length }, null, deep, wantQuality);
  }

  const indexCheck = validate.validateIndex(index, {
    hierarchyFields: hierarchy,
    baseSchema,
    availableTrees: new Set(treeFiles),
  });
  for (const err of indexCheck.errors) {
    finding('error', err.code, err.message, 'rebuild-summary (full rebuild)', { path: err.path || null, file: err.file || null });
  }

  const leaves = dsi.collectLeaves(index);

  // Counts by group and type.
  const byGroup = {};
  const byType = {};
  for (const leaf of leaves) {
    byGroup[leaf.doc_group || 'unknown'] = (byGroup[leaf.doc_group || 'unknown'] || 0) + 1;
    byType[leaf.doc_type || 'unknown'] = (byType[leaf.doc_type || 'unknown'] || 0) + 1;
  }

  // Unknown groupings and null metadata.
  (function scanUnknown(node, trail) {
    for (const child of node.children || []) {
      if (child.type === 'intermediate') {
        if (String(child.value) === 'unknown') {
          const under = dsi.collectLeaves(child).map(l => l.file);
          finding('warn', 'unknown_grouping',
            `${under.length} document(s) sit under an \`unknown\` value for hierarchy field \`${child.field}\`.`,
            'modify (re-ingest with a correct value)', { field: child.field, files: under.slice(0, 20) });
        }
        scanUnknown(child, trail.concat([`${child.field}=${child.value}`]));
      }
    }
  })(index, []);

  for (const leaf of leaves) {
    const schemaFields = (config.doc_types.schemas && config.doc_types.schemas[leaf.doc_type]) || [];
    const nulls = [].concat(baseSchema, schemaFields).filter(f => leaf[f] === null || leaf[f] === undefined);
    if (nulls.length) {
      finding('warn', 'null_metadata',
        `\`${leaf.file}\` has null value(s) for: ${nulls.join(', ')}.`,
        'modify', { file: leaf.file, fields: nulls });
    }
  }

  // Orphans and dangling entries — filename comparison only.
  const referenced = new Set(leaves.map(l => l.tree_index).filter(Boolean));
  for (const f of treeFiles) {
    if (!referenced.has(f)) {
      finding('warn', 'orphaned_tree',
        `.index/trees/${f} has no routing index entry.`,
        'rebuild-summary (insert mode), or delete the orphaned file', { tree_index: f });
    }
  }
  for (const leaf of leaves) {
    if (leaf.tree_index && !treeFiles.includes(leaf.tree_index)) {
      finding('error', 'dangling_leaf',
        `\`${leaf.file}\` points at .index/trees/${leaf.tree_index}, which does not exist.`,
        'modify, or remove to clean up the entry', { file: leaf.file, tree_index: leaf.tree_index });
    }
  }

  const stats = {
    documents: leaves.length,
    trees: treeFiles.length,
    by_doc_group: byGroup,
    by_doc_type: byType,
    hierarchy_depth: hierarchy.length,
  };

  if (!deep && !wantQuality) return report(config, findings, stats, null, deep, wantQuality);

  // -- deep ----------------------------------------------------------------
  const perDocument = [];
  const coverageBuckets = { '1.0': 0, '0.9-1.0': 0, '0.75-0.9': 0, '0.5-0.75': 0, '<0.5': 0 };
  let genericSummaries = 0;
  let duplicateSummaries = 0;
  let totalSummaries = 0;
  let crossRefTotal = 0;
  let crossRefResolved = 0;
  const rootSummaries = [];

  for (const f of treeFiles) {
    const treePath = path.join(treesDir, f);
    let tree;
    try {
      const raw = fs.readFileSync(treePath, 'utf8');
      if (raw.trim() === '') throw new Error('file is empty');
      tree = JSON.parse(raw);
    } catch (err) {
      finding('error', 'corrupted_tree', `.index/trees/${f} could not be parsed: ${err.message}`, 'modify', { tree_index: f });
      continue;
    }

    const sourcePath = tree.file ? path.join(ingestionDir, tree.file) : null;
    const opts = { wantPages: !!(config.source && config.source.page_numbers_in_citations) };
    let sourceExists = false;
    if (sourcePath && fs.existsSync(sourcePath)) {
      sourceExists = true;
      const content = fs.readFileSync(sourcePath, 'utf8');
      opts.parsed = markdown.parse(content);
      opts.fingerprint = fingerprintLib.ofContent(content);
    }

    const result = validate.validateTree(tree, opts);
    for (const err of result.errors) {
      if (err.code === 'fingerprint_mismatch') {
        finding('warn', 'stale_source',
          `\`${tree.file}\` has changed since it was indexed; cited line ranges may no longer be accurate.`,
          'modify', { file: tree.file });
      } else {
        finding('error', err.code, `${tree.file}: ${err.message}`, 'modify', { file: tree.file });
      }
    }

    if (!sourceExists && sourcePath) {
      finding('error', 'source_missing',
        `\`${tree.file}\` is indexed but its source no longer exists at ${sourcePath}.`,
        'remove (clean up the entry), or restore the file', { file: tree.file });
    }
    if (!tree.source_fingerprint) {
      finding('info', 'staleness_unknown',
        `\`${tree.file}\` has no source_fingerprint; it predates fingerprinting, so staleness cannot be determined.`,
        null, { file: tree.file });
    }

    if (result.coverage) {
      const r = result.coverage.coverage_ratio;
      if (r >= 1) coverageBuckets['1.0']++;
      else if (r >= 0.9) coverageBuckets['0.9-1.0']++;
      else if (r >= 0.75) coverageBuckets['0.75-0.9']++;
      else if (r >= 0.5) coverageBuckets['0.5-0.75']++;
      else coverageBuckets['<0.5']++;

      if (r < 1) {
        finding('warn', 'incomplete_coverage',
          `\`${tree.file}\` covers ${Math.round(r * 100)}% of its substantive lines; ${result.coverage.uncovered_count} line(s) are unreachable.`,
          'modify', { file: tree.file });
      }
    }

    // Cross-reference accounting.
    (function walkRefs(nodes) {
      for (const node of nodes || []) {
        for (const ref of node.cross_refs || []) {
          crossRefTotal++;
          if (ref.resolved_node || ref.resolved_file) crossRefResolved++;
        }
        walkRefs(node.children);
      }
    })(tree.children);

    if (wantQuality) {
      const findingsForDoc = quality.checkTree(tree, config.ingestion_quality);
      totalSummaries += countSummaries(tree);
      genericSummaries += findingsForDoc.filter(x => String(x.code).startsWith('generic_') || x.code === 'repeats_heading' || x.code === 'adds_nothing_to_heading').length;
      duplicateSummaries += findingsForDoc.filter(x => x.code === 'sibling_summaries_too_similar').length;
      if (typeof tree.root_summary === 'string') rootSummaries.push({ file: tree.file, root_summary: tree.root_summary });
      if (findingsForDoc.length) {
        finding('warn', 'summary_quality',
          `\`${tree.file}\` has ${findingsForDoc.length} summary quality issue(s).`,
          'modify (re-index to regenerate summaries)',
          { file: tree.file, issues: findingsForDoc.slice(0, 10) });
      }
    }

    perDocument.push({
      file: tree.file,
      tree_index: f,
      valid: result.ok,
      coverage: result.coverage ? result.coverage.coverage_ratio : null,
      errors: result.errors.length,
    });
  }

  const qualityReport = wantQuality ? {
    total_summaries: totalSummaries,
    generic_summaries: genericSummaries,
    generic_rate: totalSummaries ? Number((genericSummaries / totalSummaries).toFixed(4)) : 0,
    duplicate_sibling_summaries: duplicateSummaries,
    root_summary_collisions: quality.checkRootDistinctness(rootSummaries, config.ingestion_quality).length,
    coverage_distribution: coverageBuckets,
    cross_references: {
      total: crossRefTotal,
      resolved: crossRefResolved,
      resolution_rate: crossRefTotal ? Number((crossRefResolved / crossRefTotal).toFixed(4)) : null,
    },
  } : null;

  return report(config, findings, Object.assign(stats, { coverage_distribution: coverageBuckets }), { per_document: perDocument, quality: qualityReport }, deep, wantQuality);
}

function countSummaries(tree) {
  let n = tree.root_summary ? 1 : 0;
  (function walk(nodes) {
    for (const node of nodes || []) { if (node.summary) n++; walk(node.children); }
  })(tree.children);
  return n;
}

function report(config, findings, stats, deepReport, deep, wantQuality) {
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warn');
  return {
    payload: {
      ok: errors.length === 0,
      mode: { deep, quality: wantQuality },
      config_summary: {
        schema_version: config.schema_version,
        vault_type: config.vault.type,
        ingestion_directory: config.vault.ingestion_directory,
        hierarchy_fields: (config.doc_summary_index && config.doc_summary_index.hierarchy_fields) || [],
        chunking: config.chunking,
        ingestion_quality: config.ingestion_quality,
      },
      stats,
      errors: errors.length,
      warnings: warnings.length,
      findings,
      deep: deepReport,
    },
    exitCode: errors.length === 0 ? cli.EXIT_OK : cli.EXIT_FAILED,
  };
}

cli.run(main);
