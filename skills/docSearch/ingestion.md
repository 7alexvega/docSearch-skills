---
name: ingestion
description: Add documents to the docSearch Index. Builds a tree index for each markdown file and updates the Document Summary Index. Use when the user runs /ingest or says anything like "add this file to the index", "index this document", "ingest this directory", "add these files to the index", or "index my vault". Accepts a single file path, a list of file paths, or a directory path.
needs: [global-rules, vocabulary, directory-structure, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `.claude/skills/docSearch/context.md` in full before proceeding. This file contains the global rules, vocabulary, directory structure, and all JSON schemas that this skill depends on. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Ingestion Skill

You are adding one or more markdown documents to the docSearch Index. For each document you build a tree index JSON and insert a leaf node into the Document Summary Index. This skill is the foundation of the entire index — the quality of tree summaries you write here directly determines how accurately the query skill can navigate and retrieve answers later.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:

> "No index configuration found. Please run /docSearch:onboard first."

Load and hold in context:

- `vault.ingestion_directory`
- `vault.doc_type_path_mappings`
- `source.page_numbers_in_citations`
- `source.page_numbers_present`
- `doc_types.base_schema`
- `doc_types.schemas`
- `chunking.fallback_chunk_size_lines`
- `chunking.max_section_size_lines`

---

## Step 1 — Resolve input

The user will provide one of:

- A single file path
- A list of file paths
- A directory path

**Single file:** confirm the file exists on disk. If not, hard stop with the path that was not found.

**List of files:** confirm each file exists. Report any that do not exist and ask the user whether to continue with the valid files or abort entirely.

**Directory:** recursively find all `.md` files under the given directory. Report the count to the user before proceeding:

> "Found 12 markdown files under `financial/`. Proceeding with ingestion."

If no `.md` files are found, hard stop:

> "No markdown files found under `<path>`. Nothing to ingest."

---

## Step 2 — Resolve doc type for each file

For each file, determine its doc type using `vault.doc_type_path_mappings` from config. A file matches a mapping if its path relative to `vault.ingestion_directory` starts with the mapped subdirectory prefix.

**Example:** if mappings are `{"10-K": "financial/", "user_reviews": "reviews/"}` and the file is `financial/2023/apple-10k.md`, it matches `10-K`.

**If a file matches no mapping:** do not skip it silently. Pause ingestion for that file and ask:

> "`reports/misc/some-file.md` does not match any doc type mapping in your config. What doc type should this file be treated as?"

Show the available doc types from config as options. If the user names a doc type not in config, ask whether they want to add it — if yes, tell them to run `/docSearch:config-update` first, then re-run ingestion for that file. Do not invent doc types not in config.

**If processing a batch:** collect all unmatched files first before asking, so you ask once rather than interrupting repeatedly:

> "The following files do not match any doc type mapping. What doc type should each be treated as?
>
> - `reports/misc/file-a.md`
> - `reports/misc/file-b.md`"

---

## Step 3 — Parallel execution for batches

For a single file, process it directly in Steps 4–6.

For a list or directory of files, spawn one sub-agent per file. All sub-agents run in parallel. Each sub-agent receives:

- The file path
- The resolved doc type for that file
- The full config values loaded in the preamble

Each sub-agent executes Steps 4–6 independently. Collect results from all sub-agents before proceeding to Step 7.

---

## Step 4 — Build the tree index

This is the most important step. The summaries you write at each node are what the query skill uses to navigate. Write them to be information-dense and specific — vague summaries cause the query skill to make wrong navigation decisions and retrieve irrelevant content.

### 4.1 — Read the file

Read the full markdown file. Note its total line count.

### 4.2 — Detect page numbers (if configured)

If `source.page_numbers_in_citations` is true in config, scan the file for page number markers. The pattern was confirmed during onboarding — look for the pattern that appears in this file. Common patterns include:

- `<!-- Page 4 -->`
- `---page 4---`
- `Page 4`
- `\f` (form feed character)

Build a map of `page_number → line_number` so you can assign `page_range` to every node. If you cannot find page number markers despite the config saying they should be present, hard stop:

> "Page numbers are configured but no page number markers were found in `<filename>`. Check the file or run /docSearch:config-update to disable page numbers."

### 4.3 — Parse heading structure

Walk the file line by line. Identify all markdown headings (`#`, `##`, `###`, `####`, etc.) and their line numbers. Build the heading hierarchy.

**Case A — File has headings:**
Build the tree from the heading structure. Each heading becomes a node. A heading's content spans from its own line to the line before the next heading at the same or higher level.

If any section's line span exceeds `chunking.max_section_size_lines` from config, split that section into sub-chunks:

- Divide the section content into chunks of `max_section_size_lines` lines each
- Each chunk becomes a child node under the heading node
- Label auto-generated chunks as `<heading text> — Part 1`, `<heading text> — Part 2`, etc.
- These chunks are leaf nodes — give them `content_ref` with their line range
- The parent heading node is no longer a leaf — it has these chunks as children and does not get `content_ref`

**Case B — File has no headings:**
Build a flat tree. Split the entire file into chunks of `chunking.fallback_chunk_size_lines` lines. Each chunk becomes a child node directly under the root. Label them `Chunk 1`, `Chunk 2`, etc. All chunks are leaf nodes.

### 4.4 — Write node summaries

For every node write a summary. This is the most consequential part of ingestion — take care here.

**What makes a good summary:**

- Specific about content — names entities, concepts, figures, and topics actually present in that section
- Answers the question "what would a user be looking for when they need this section?"
- Does not copy the heading text verbatim — adds information the heading does not already convey
- 1–3 sentences maximum

**Bad summary:** "This section covers revenue."
**Good summary:** "Q1 2023 revenue breakdown by segment — iPhone, Services, Mac, iPad, and Wearables. Includes year-over-year comparisons and management commentary on Services growth."

**Root summary:** summarize the entire document. Include the doc type, the entity it covers, the time period if applicable, and the main topics. This is what the query skill reads first when deciding whether this document is relevant to a query.

### 4.5 — Assign page ranges (if configured)

If `source.page_numbers_in_citations` is true, use the page map built in 4.2 to assign `page_range: [start_page, end_page]` to every node including the root. A node's page range spans from the first page marker at or before its first line to the last page marker at or before its last line.

If a node's content falls entirely within a single page, `page_range` is `[page, page]`.

### 4.6 — Assign content_ref to leaf nodes

Every leaf node (a node with no children) gets a `content_ref` field:

```json
"content_ref": {
  "lines": [start_line, end_line]
}
```

Line numbers are 1-indexed. Inclusive on both ends.

Non-leaf nodes never get `content_ref`.

### 4.7 — Detect and resolve cross-references

After the full node structure is built, make a second pass over every node to detect cross-reference patterns in the raw content of that node's line range. Do this for every node regardless of whether it is a leaf or non-leaf.

**Patterns to detect:**

- Explicit note references: `Note 12`, `Note 12(a)`, `footnote 3`
- Section references: `Section 4.2`, `see section N`, `refer to Part II`
- Page references: `see page 47`, `on page 12`
- Heading references: `as discussed in the Risk Factors section`, `see Revenue above`
- Informal document references: `prior year filing`, `see the 10-K for`, `as noted in <filename>`
- Any phrase matching `see [X]`, `refer to [X]`, `as described in [X]`, `per [X]`

This list is not exhaustive — use judgment to identify any pattern that signals the content of this node depends on or points to content elsewhere.

**For each detected cross-reference:**

Determine type:

- `intra` if the target appears to be within the same document (a section, note, page, or heading that exists in this tree)
- `inter` if the target appears to be a different document (a filename, a reference to a different filing, a prior year document)

Attempt resolution:

- For `intra`: scan the tree node structure for a node whose heading matches or closely matches the target. If found, record its node identifier as `resolved_node`. A node identifier is constructed as the tree index filename stem plus the heading text lowercased with spaces replaced by hyphens — e.g. `financial_2023_apple-10k_notes_note-12`.
- For `inter`: search the Document Summary Index leaf nodes for a leaf whose `file` field matches the referenced document. If found, record the relative file path as `resolved_file`.

Record unresolved references with `null` for the unresolvable field. Do not discard unresolved references — they are still meaningful to the query skill even if the target cannot be navigated automatically.

**Update node summaries for nodes with cross-references:**
If a node has cross-references, append the dependency to its summary so the query skill is aware without needing to read `cross_refs` first:

- Before: `"Q1 revenue increased 12%."`
- After: `"Q1 revenue increased 12%. Methodology detailed in Note 8 (cross-ref)."`

### 4.8 — Construct the tree index JSON

Assemble the complete tree following the Tree Index Structure defined in `context.md`. The filename for the tree index is derived from the file's relative path from `vault.ingestion_directory`, with directory separators (`/`) replaced by underscores (`_`) and `.md` replaced by `.json`.

**Example:**

```
financial/2023/apple-10k.md  →  .index/trees/financial_2023_apple-10k.json
```

Write the tree index JSON to `.index/trees/`.

---

## Step 5 — Build the Document Summary Index leaf node entry

Construct the Document Summary Index leaf node entry for this document using the base schema and the doc type extension schema from config.

**Base fields** (always present):

- `file` — relative path from ingestion directory e.g. `financial/2023/apple-10k.md`
- `doc_type` — resolved doc type
- `doc_group` — from config schemas
- `topics` — extract from the document. These should be specific enough to enable routing. For a 10-K: `["Q1 revenue", "operating expenses", "segment performance", "risk factors"]`. Not: `["finance", "numbers"]`
- `date_added` — today's date in ISO format

**Extension fields:** for each field defined in `doc_types.schemas[doc_type]`, extract the value from the document. If you cannot confidently determine a value (e.g. `fiscal_year` is ambiguous), do not guess — set it to `null` and flag it in your completion report so the user knows.

**Prose summary:** generate a 2–4 sentence prose summary of the document derived from the tree's `root_summary`. This is richer than the `topics` field — it should describe the document's content in a way that enables routing for open-ended natural language queries that do not map cleanly to metadata fields.

Good prose summary: `"Apple fiscal year 2023 annual filing. Revenue of $383B across iPhone, Services, Mac, iPad and Wearables segments. Covers competitive risks in smartphone and services markets, EU regulatory exposure, supply chain dependencies, and 2024 management outlook."`

Poor prose summary: `"This is an Apple 10-K filing for 2023."` — too vague to aid routing.

This summary becomes the `summary` field on the Document Summary Index leaf node.

---

## Step 6 — Call rebuild-summary

Once the tree index JSON is written, call the rebuild-summary skill in append mode for this document, passing:

- All metadata fields constructed in Step 5
- The prose summary constructed in Step 5
- The tree index filename

Rebuild-summary will insert a new leaf node into the Document Summary Index tree at the correct position based on the hierarchy fields in config. Do not write to `document-summary-index.json` directly from this skill.

---

## Step 7 — Report results

After all files are processed (all sub-agents complete for batch runs), report a summary:

**Success format:**

```
Ingestion complete.

✓ financial/2023/apple-10k.md → 10-K (47 nodes, 4 levels)
✓ financial/2024/apple-10k.md → 10-K (52 nodes, 4 levels)
✓ reviews/q1-2023.md → user_reviews (12 nodes, 2 levels)

3 documents indexed. Document Summary Index updated.
```

**If any files failed:**

```
Ingestion complete with errors.

✓ financial/2023/apple-10k.md → 10-K (47 nodes, 4 levels)
✗ financial/2024/apple-10k.md → FAILED: page number markers not found
✓ reviews/q1-2023.md → user_reviews (12 nodes, 2 levels)

2 documents indexed. 1 failed. See errors above.
Master summary updated for successful files only.
```

**Flag any null extension fields:**

```
⚠ financial/2023/apple-10k.md: could not confidently determine `fiscal_quarter` — set to null. Verify and run /docSearch:modify if needed.
```

---

## Error handling

**File not found:** hard stop for single file. For batch, report and ask whether to continue or abort.

**Tree index already exists:** a file with this tree index filename already exists in `.index/trees/`. This means the document was previously ingested. Hard stop and tell the user:

> "`financial/2023/apple-10k.md` has already been indexed. To re-index it, use /docSearch:modify instead."

Do not overwrite an existing tree index silently.

**Write failure:** if writing the tree index JSON fails, hard stop and report the exact error. Do not call rebuild-summary if the tree index was not written successfully.

**Rebuild-summary failure:** if rebuild-summary fails, report it clearly. The tree index file was written but the Document Summary Index was not updated — tell the user they can run `/docSearch:rebuild-summary` manually to recover.
