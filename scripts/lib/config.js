'use strict';

const fs = require('fs');
const path = require('path');
const { fail } = require('./cli');
const paths = require('./paths');

// The highest config shape these scripts understand. A vault written by a
// newer release must not be silently misread.
const SUPPORTED_SCHEMA_VERSION = 2;

// Defaults for every quality knob. A vault onboarded before `ingestion_quality`
// existed gets these without needing migration — absent means default, not
// error, exactly as `schema_version: 0` does for the config as a whole.
const QUALITY_DEFAULTS = {
  placeholder_word_threshold: 20,
  sibling_summary_similarity_max: 0.85,
  root_summary_similarity_max: 0.9,
  semantic_retry_limit: 2,
  max_nodes_per_semantic_batch: 12,
  max_content_characters_per_semantic_batch: 30000,
  node_summary_min_words: 15,
  node_summary_max_words: 60,
  root_summary_min_words: 30,
  root_summary_max_words: 100,
};

const CHUNKING_DEFAULTS = {
  fallback_chunk_size_lines: 150,
  max_section_size_lines: 200,
};

function load(cwd) {
  const file = paths.configPath(cwd);
  if (!fs.existsSync(file)) {
    throw fail(
      'no_config',
      `No index configuration found in ${path.resolve(cwd || process.cwd())}. Run the onboard skill first.`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw fail('bad_config', `${file} exists but could not be parsed as JSON: ${err.message}`);
  }

  const version = typeof raw.schema_version === 'number' ? raw.schema_version : 0;
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw fail(
      'future_schema',
      `This index was created by a newer version of docSearch (schema_version ${version}) than what is installed here. Update the docSearch skill package before using this index.`
    );
  }

  raw.schema_version = version;
  raw.chunking = Object.assign({}, CHUNKING_DEFAULTS, raw.chunking || {});
  raw.ingestion_quality = Object.assign({}, QUALITY_DEFAULTS, raw.ingestion_quality || {});
  raw.source = raw.source || {};
  raw.vault = raw.vault || {};
  raw.doc_types = raw.doc_types || {};

  if (!raw.vault.ingestion_directory) {
    throw fail('bad_config', 'config.json is missing vault.ingestion_directory.');
  }

  return raw;
}

// Resolves the doc type for a source path using vault.doc_type_path_mappings.
// Returns null rather than guessing — the caller decides whether to ask the
// user or fail, since that policy differs between ingest and sync.
function docTypeFor(config, relativePath) {
  const mappings = config.vault.doc_type_path_mappings || {};
  const rel = paths.toPosix(relativePath);
  let best = null;
  for (const [docType, prefixRaw] of Object.entries(mappings)) {
    const prefix = paths.toPosix(prefixRaw).replace(/^\.\//, '').replace(/\/*$/, '/');
    if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) {
      // Longest prefix wins, so nested mappings resolve to the specific one.
      if (!best || prefix.length > best.prefix.length) best = { docType, prefix };
    }
  }
  return best ? best.docType : null;
}

function docGroupFor(config, docType) {
  const groups = config.doc_types.doc_groups || {};
  return groups[docType] || null;
}

module.exports = { load, docTypeFor, docGroupFor, SUPPORTED_SCHEMA_VERSION, QUALITY_DEFAULTS, CHUNKING_DEFAULTS };
