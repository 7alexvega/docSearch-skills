'use strict';

const fs = require('fs');
const { fail } = require('./cli');
const paths = require('./paths');

// ---------------------------------------------------------------------------
// Document Summary Index helpers.
//
// The DSI is the routing layer: a tree whose depth is whatever
// `doc_summary_index.hierarchy_fields` says it is. Nothing here assumes a
// particular field sits at a particular level — homogeneous vaults legitimately
// omit doc_group/doc_type as levels while still carrying them on every leaf.
// ---------------------------------------------------------------------------

function emptyIndex() {
  return {
    type: 'root',
    summary: '',
    children: [],
  };
}

function load(cwd) {
  const file = paths.dsiPath(cwd);
  if (!fs.existsSync(file)) {
    throw fail('no_dsi', `document-summary-index.json not found at ${file}. Run the onboard skill to initialize the index.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw fail('bad_dsi', `document-summary-index.json exists but could not be parsed: ${err.message}. Run rebuild-summary (full rebuild) to recover from tree indexes.`);
  }
}

function loadOrEmpty(cwd) {
  const file = paths.dsiPath(cwd);
  if (!fs.existsSync(file)) return emptyIndex();
  return load(cwd);
}

function collectLeaves(node, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'leaf') { acc.push(node); return acc; }
  for (const child of node.children || []) collectLeaves(child, acc);
  return acc;
}

function findLeafByFile(index, file) {
  return collectLeaves(index).find(l => l.file === file) || null;
}

function leafFileSet(index) {
  return new Set(collectLeaves(index).map(l => l.file));
}

// Walks to the insertion point for a leaf, creating intermediate nodes as
// needed, and returns the parent that should receive it. Mutates `index`.
function ensurePath(index, hierarchyFields, metadata) {
  let node = index;
  for (let i = 0; i < hierarchyFields.length - 1; i++) {
    const field = hierarchyFields[i];
    const rawValue = metadata[field];
    const value = rawValue === undefined || rawValue === null || rawValue === '' ? 'unknown' : String(rawValue);
    let next = (node.children || []).find(c => c.type === 'intermediate' && c.field === field && String(c.value) === value);
    if (!next) {
      next = { type: 'intermediate', field, value, summary: '', children: [] };
      node.children = node.children || [];
      node.children.push(next);
    }
    node = next;
  }
  return node;
}

function unknownFieldsFor(hierarchyFields, metadata) {
  const missing = [];
  for (const field of hierarchyFields.slice(0, Math.max(0, hierarchyFields.length - 1))) {
    const v = metadata[field];
    if (v === undefined || v === null || v === '') missing.push(field);
  }
  return missing;
}

// Removes a leaf and any intermediate nodes left childless by its removal.
// Never removes the root.
function removeLeaf(index, file) {
  let removed = false;
  function prune(node) {
    if (!node.children) return;
    const before = node.children.length;
    node.children = node.children.filter(c => !(c.type === 'leaf' && c.file === file));
    if (node.children.length !== before) removed = true;
    for (const child of node.children) prune(child);
    node.children = node.children.filter(c => c.type === 'leaf' || (c.children && c.children.length > 0));
  }
  prune(index);
  return removed;
}

module.exports = {
  emptyIndex,
  load,
  loadOrEmpty,
  collectLeaves,
  findLeafByFile,
  leafFileSet,
  ensurePath,
  unknownFieldsFor,
  removeLeaf,
};
