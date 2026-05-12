---
name: rebuild-summary
description: Maintains the Document Summary Index tree. Called internally by ingestion (append mode) and remove (delete mode). Rarely run directly by the user. Trigger when the user runs /rebuild-summary or says "update the document summary index", "fix the document summary index entry for X", "the index is out of sync", or "rebuild the routing index".
needs: [global-rules, vocabulary, directory-structure, config-schema, document-summary-index-schema]
---

## Step 0 — Load shared context

Read `.claude/skills/docSearch/context.md` in full before proceeding. This file contains the global rules, vocabulary, directory structure, and JSON schemas that this skill depends on. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `config-schema`, `document-summary-index-schema`.

---

# Rebuild-Summary Skill

You are maintaining the Document Summary Index tree stored at `.index/document-summary-index.json`. This is the routing layer of the entire system — the query skill navigates this tree to identify candidate documents before loading any per-document tree indexes. Corrupting or incorrectly updating it means queries get routed to the wrong documents or fail entirely.

This skill operates in three modes: append, delete, and full rebuild. It is called internally by ingestion and remove. The full rebuild option is only used for recovery.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:
> "No index configuration found. Please run /docSearch:onboard first."

Read `document-summary-index.json` from `.index/`. If it does not exist, hard stop:
> "document-summary-index.json not found. If this is a fresh index, run /docSearch:onboard to initialize it."

Load from config:
- `doc_summary_index.hierarchy_fields` — the ordered list of fields that define the tree structure
- `doc_types.schemas` — to know which fields belong to which doc types

---

## Modes

### Append mode
Called by ingestion after a new tree index is successfully written.

Receives:
- All metadata fields for the document (file, doc_type, doc_group, topics, date_added, all extension fields)
- A prose summary of the document
- The tree index filename

**1 — Check for duplicates**
Search the Document Summary Index tree for an existing leaf node whose `file` field matches. If found, hard stop:
> "A leaf node for `<file>` already exists in the Document Summary Index. Use modify mode to update an existing entry."

**2 — Validate**
Confirm all base fields are present: `file`, `doc_type`, `doc_group`, `topics`, `date_added`, `summary`, `tree_index`. If any are missing, hard stop and report which fields are absent.

Confirm the tree index file exists at `.index/trees/<tree_index_filename>`. If not, hard stop:
> "Cannot insert leaf node for `<file>` — tree index `<tree_index_filename>` not found."

**3 — Navigate and insert**
Using `doc_summary_index.hierarchy_fields` from config, walk the Document Summary Index tree to find the correct insertion point.

For each level in the hierarchy:
- The field name comes from `hierarchy_fields[level]`
- The field value comes from the document's metadata
- Look for an existing intermediate node at this level whose `value` matches
- If found: descend into it
- If not found: create a new intermediate node with `type: "intermediate"`, `field: <field_name>`, `value: <field_value>`, `summary: ""`, `children: []`

Insert the leaf node at the deepest level:
```json
{
  "type": "leaf",
  "field": "<last hierarchy field>",
  "value": "<field value>",
  "file": "<relative path>",
  "doc_type": "<doc_type>",
  "doc_group": "<doc_group>",
  "topics": ["<topic>", "..."],
  "date_added": "<ISO date>",
  "<extension_field>": "<value>",
  "summary": "<prose summary>",
  "tree_index": "<tree_index_filename>"
}
```

**4 — Update intermediate node summaries**
Walk back up updating the `summary` on every intermediate node traversed, plus the root. Each intermediate summary must reflect all documents in its subtree — update to include the new document.

Good intermediate summary: `"Apple filings including 10-K for 2022, 2023, and 2024 covering revenue, segment performance, risk factors, and management outlook"`

Poor intermediate summary: `"Apple documents"` — too vague to aid routing decisions.

**5 — Write**
Write the updated `document-summary-index.json` to disk.

Report: `✓ Document Summary Index updated — leaf node inserted for <file>`

---

### Delete mode
Called by remove after the user confirms deletion of a document.

Receives:
- The `file` value (relative path) of the leaf node to delete

**1 — Find the leaf node**
Search the tree for a leaf node whose `file` field matches exactly. If not found, hard stop:
> "No leaf node found in Document Summary Index for `<file>`. Nothing to delete."

**2 — Remove the leaf**
Remove the leaf node from its parent's `children` array.

**3 — Prune empty intermediate nodes**
Check whether the parent intermediate node now has an empty `children` array. If empty, remove it from its parent. Continue pruning upward until a non-empty node is reached. Never prune the root node.

**4 — Update intermediate node summaries**
Walk back up from the deletion point updating summaries on all intermediate nodes that still have children to reflect what remains.

**5 — Write**
Write the updated `document-summary-index.json` to disk.

Report: `✓ Document Summary Index updated — leaf node removed for <file>`

---

## Direct user invocation

If the user runs `/docSearch:rebuild-summary` directly, ask what they need:

> "Rebuild-summary can:
> 1. Insert a leaf node for a specific file — if ingestion completed but the Document Summary Index was not updated
> 2. Delete a leaf node for a specific file — if remove failed partway through
> 3. Full rebuild — re-reads all tree indexes in `.index/trees/` and reconstructs the entire Document Summary Index from scratch. Use only if the index is corrupted or severely out of sync.
>
> Which do you need?"

For options 1 and 2, proceed with the relevant mode above.

For option 3 — full rebuild:

1. Warn the user:
   > "A full rebuild will replace the entire document-summary-index.json by reading all tree index files. This does not modify any tree index files. Proceed?"

2. Wait for confirmation.

3. Read every `.json` file in `.index/trees/`.

4. For each tree index extract: `file`, `doc_type` from the root. Derive `doc_group` from config. Extract extension field values from root summary where possible. Set `date_added` to today's date if not recoverable. Generate a prose summary from `root_summary`. Reconstruct `topics` from root summary.

5. Build the complete tree using `doc_summary_index.hierarchy_fields` — insert all documents in correct positions, create all intermediate nodes, write all intermediate summaries.

6. Write the new `document-summary-index.json`.

7. Report how many leaf nodes were reconstructed and flag any where fields could not be confidently recovered.

---

## Error handling

**Write failure:** hard stop and report the exact error. Tell the user the in-memory state of what was about to be written so they can recover manually.

**Corrupted document-summary-index.json:** if the file cannot be parsed as valid JSON, hard stop:
> "document-summary-index.json exists but could not be parsed. It may be corrupted. Run /docSearch:rebuild-summary and choose option 3 (full rebuild) to recover from tree index files."

Never attempt to repair corrupted JSON — always direct to full rebuild.

**Missing hierarchy field value:** if a document's metadata is missing a value for a field in `hierarchy_fields` (e.g. `company` is null), place the leaf node under an intermediate node with `value: "unknown"` at that level. Flag this in the report:
> "⚠ `<file>` has null value for hierarchy field `<field>` — placed under `unknown` grouping. Run /docSearch:modify to re-ingest with a correct value."
