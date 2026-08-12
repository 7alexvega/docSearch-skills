# docSearch Shared Context

This file is the single source of truth for all shared vocabulary, rules, directory structure, and JSON schemas used across the docSearch skill suite. Every skill reads this file in Step 0 before doing anything else.

---

<!-- section: global-rules -->
## Global Rules

These rules apply to every skill without exception.

### Config first

Every skill must read `.index/config.json` as its first action before doing anything else. The `.index/` directory is always resolved relative to the current working directory — the directory Claude Code (or Codex) was launched in — never relative to where the skill files themselves are installed. This matters most for global installs (`claude-global`/`codex-global`), where skills are available from every project but each project's `.index/` is independent; see `directory-structure` for details. If `.index/config.json` does not exist at `<cwd>/.index/config.json`, hard stop naming the directory that was searched:

> "No index configuration found in `<cwd>`. Please run /docSearch:onboard first."

### Schema version

The docSearch skill suite currently understands up to `schema_version: 2` (see `config-schema`). The scripts check this themselves on every run, so a skill only needs to act on what a script reports. For reference:

- **Absent** — the config predates schema versioning. Treat it as version `0`. This is not an error — it is the expected state for any vault onboarded before this field existed. Normal field-presence checks handle the resulting gaps gracefully (for example, a tree index without `source_fingerprint` just skips the staleness check rather than failing).
- **Present and `<= 2`** — proceed normally. Version `1` artifacts remain queryable; `/docSearch:doctor --quality` reports their quality as unverified under the current policy, and `/docSearch:modify` upgrades one document at a time.
- **Present and `> 2`** — this index was built by a newer release of docSearch than what's installed. Hard stop:
  > "This index was created by a newer version of docSearch (schema_version `<N>`) than what's installed here. Update the docSearch skill package before using this index."

`/docSearch:doctor` reports the current value in its config summary.

### Never edit JSON manually

No skill ever instructs the user to manually edit config.json, document-summary-index.json, or any tree index JSON. All changes to these files go through the appropriate skill.

### Hard stop on errors

If any skill encounters an unrecoverable error, it must immediately stop and report the exact error with a clear explanation of what went wrong, what file or operation caused it, and what the user should do next. Never attempt to self-correct silently or continue past an error.

Examples of hard stop conditions:

- config.json missing or unparseable
- A tree index JSON referenced in document-summary-index.json does not exist on disk
- A source markdown file cannot be found at the path recorded in the tree index
- A required config field is missing or has an unexpected value
- A schema migration is required but has not been run after a config change

### No ambiguity

No skill proceeds with an assumption when the correct behavior is unclear. If a situation is ambiguous, the skill asks the user one clarifying question and waits for an answer before continuing.

### Confirm before writing

Any skill that writes to config.json or document-summary-index.json must show the user what it is about to write and receive explicit confirmation before writing. Tree index writes during ingestion do not require per-file confirmation but must report success or failure per file.

### Defaults are explicit

Whenever a skill presents a configurable value, it must show the default value clearly so the user can make an informed choice. A user accepting a default must do so consciously, not by omission.

### Structure is generated, never written by hand

No skill constructs, edits, or repairs the JSON inside `.index/` directly. Tree shape, node ids, line ranges, page ranges, coverage, and the routing index are produced by the pipeline scripts described in `pipeline`. A model's only writable surface is `summary`, `root_summary`, `topics`, and extension-field metadata — and those are validated mechanically before publication.

This is what makes Claude and Codex produce identical artifacts, and what makes correctness independent of hooks, of write-tool choice, and of any skill being read carefully.

If an index is wrong, the fix is to re-run the pipeline, never to patch the JSON.

### Skills call scripts

Ingest, Modify, Sync, and Remove all mutate through the same scripts and the same transaction engine. Sync produces a diff and then drives Ingest, Modify, and Remove for the categories the user confirms. Schema-migrate is called by Config-update when schema changes are detected. These internal calls are transparent — the skill reports what it is doing at each step.
<!-- /section -->

---

<!-- section: vocabulary -->
## Vocabulary

These terms are used consistently across all skills. Do not redefine them.

**Document Summary Index** — The file `.index/document-summary-index.json`. A navigable tree structure used exclusively for query routing — never for answering queries directly. The query skill navigates this tree top-down to identify candidate documents before loading any per-document tree indexes. The tree is organized by hierarchy fields defined during onboarding (e.g. doc_group → doc_type → company → fiscal_year). Intermediate nodes hold summaries of their subtree. Leaf nodes hold document metadata and a prose summary pointing to a per-document tree index.

**Tree index** — A per-document JSON file stored at `.index/trees/<filename>.json`. Represents the document as a navigable hierarchy of nodes, each with a summary and a line range pointing to the source file. Used for hierarchical navigation within a document.

**Leaf node** — The deepest node in a tree index. Contains a line range reference to the actual content in the source markdown file. The only node type from which content is retrieved.

**Node summary** — A concise description of what a node and its children contain. Used by the query skill to decide which branch to descend into without reading actual content.

**Citation trail** — The full path from answer back to source: document filename → section hierarchy → line range → page numbers (if configured). Always included in query output.

**Doc type** — The specific format of a document, e.g. `10-K`, `user_reviews`, `API_reference`. Defined during onboarding. Determines which metadata schema fields apply to a document.

**Doc group** — The category a doc type belongs to. Selected from a fixed set during onboarding. Used for cross-type query filtering. Fixed options: `financial`, `legal`, `technical`, `research`, `qualitative`, `operational`, `general`.

**Schema migration** — The process of updating Document Summary Index leaf nodes when the config schema changes post-onboarding. Always run via `/docSearch:schema-migrate`, never manually.

**Homogeneous vault** — A vault containing only one doc type.

**Mixed vault** — A vault containing multiple doc types. Requires cross-type join fields to be defined in config.

**Cross-type join fields** — Fields that exist across multiple doc types under different names but represent the same concept (e.g. `fiscal_year` in 10-K maps to `period` in user_reviews). Defined in config. Required for cross-type queries to work correctly.

**Aggregation query** — A query that requires retrieving and comparing data across multiple documents, e.g. "which year had the highest Q1 revenue." Automatically receives a higher node budget than single-document queries.
<!-- /section -->

---

<!-- section: directory-structure -->
## Index Directory Structure

Where the *skills themselves* are installed depends on the install target chosen at setup (see the package README): flat commands under `.claude/commands/docSearch/*.md` for `claude-local`/`claude-global`, or per-skill folders under `.codex/skills/docSearch-<skill>/SKILL.md` for `codex-local`/`codex-global`. That location is fixed at install time and is unrelated to any specific vault.

The **index itself** is different: `.index/` is always resolved relative to the current working directory at the moment a skill runs — never relative to wherever the skill files are installed:

```
<project vault root>/    ← the cwd where Claude Code / Codex is running
  .index/                ← always here, relative to cwd
    config.json
    document-summary-index.json
    trees/
      <document-name>.json
      ...
```

Every skill locates `.index/` relative to the current working directory without reading context first. This means any skill can hard stop immediately if `.index/config.json` is not found at `<cwd>/.index/config.json`.

**Global installs (`claude-global`/`codex-global`) make this a per-project vault model.** Installing globally makes every docSearch skill invocable from any directory on the machine, but each directory gets its own independent `.index/` — there is no shared or "default" vault. Running `/docSearch:query` from `~/vaultA` searches `~/vaultA/.index/`; the same command from `~/vaultB` searches a completely separate `~/vaultB/.index/`. A user who onboarded in one directory and later runs a skill from a different, never-onboarded directory hits the "No index configuration found in `<cwd>`" hard stop above — naming the searched directory explicitly is what makes that failure diagnosable instead of mysterious.
<!-- /section -->

---

<!-- section: pipeline -->
## The Pipeline Scripts

Every mutation to `.index/` goes through these. They live at `{{DOCSEARCH_SCRIPTS}}` and are invoked with `node`. They are plain Node with no dependencies, identical across all four install targets, and they behave the same whether a skill, a shell, or CI calls them.

### Shared contract

- **stdout is always a single JSON object**, and nothing else. Human-readable notes go to stderr. A skill can capture and parse stdout without stripping log noise.
- **Exit codes:** `0` success · `1` the operation ran but its subject failed validation · `2` the operation could not run at all (bad usage, missing config, unreadable file).
- **`--cwd <path>`** overrides the vault root. Omit it and the current working directory is used, which is what a skill normally wants.
- Errors carry a stable `error.code` — `no_config`, `bad_config`, `future_schema`, `outside_ingestion_dir`, `source_missing`, `no_page_markers`, `doc_type_unresolved` — so a skill can branch on the failure kind instead of pattern-matching prose.

### The scripts

| Script | Purpose |
|---|---|
| `selftest.js` | Proves the install: path resolution, Node version, lib loading, config read, vault write. Run this first when anything is behaving oddly. |
| `scan-vault.js` | Discovery and classification. Resolves inputs, enforces the ingestion-directory boundary, fingerprints, and classifies every source. Writes nothing. |
| `build-tree.js` | Builds one document's complete tree skeleton with all summaries `null`, and validates it. |
| `validate-tree.js` | Checks an existing tree — structure, coverage, staleness — with `--tree <path>` or `--all`. |
| `build-semantic-queue.js` | Turns skeletons into self-contained work batches. |
| `merge-semantic-results.js` | Folds summaries into skeletons, proves the structure is unchanged, applies quality rules, emits routing leaves. |
| `publish-batch.js` | The only writer into `.index/`. Revalidates, backs up, publishes atomically, verifies, rolls back on failure. |
| `remove-document.js` | Transactional removal of one or more documents. |
| `sync-plan.js` | Three-way diff between the vault and the index. Writes nothing. |
| `doctor.js` | Read-only health report. `--deep` parses every tree and checks sources; `--quality` adds summary-quality metrics. |

### What the scripts own, and what a model owns

Scripts own, and a model may never write: tree shape, heading hierarchy, line ranges, page ranges, fingerprints, node ids, tree filenames, `children` arrays, `content_ref`, cross-reference JSON shape, routing index structure, transaction files, and validation results.

A model owns exactly: `summary`, `root_summary`, `topics`, and doc-type extension metadata.

The merge step takes a structural signature of each tree before and after folding in model output and refuses the merge if they differ at all — so this boundary is enforced, not merely documented.

### Staging

Work in progress lives at `.index/staging/<run_id>/`:

```
.index/staging/<run-id>/
  trees/                  skeletons, summaries still null
  semantic-queue/         batch-001.json, batch-002.json, …
  semantic-results/       one results file per batch
  merged/                 skeletons + summaries, plus leaves.json
  backup/                 everything at risk during publication
  transaction.json        what was published, what failed, whether it rolled back
```

Provisional output may be invalid inside staging. It may never be invalid in `.index/trees/` or `document-summary-index.json`. Staging is not cleaned up automatically — it is the audit trail for a run and the recovery material if one goes wrong.
<!-- /section -->

---

<!-- section: config-schema -->
## Config.json Structure

All skills read and write config using this exact structure. No skill adds fields not defined here without a corresponding /docSearch:config-update or /docSearch:onboard run.

```json
{
  "schema_version": 2,
  "vault": {
    "type": "homogeneous | mixed",
    "ingestion_directory": "<absolute path>",
    "doc_type_path_mappings": {
      "<doc_type>": "<subdirectory relative to ingestion_directory>"
    }
  },
  "source": {
    "docling_used": true,
    "page_numbers_present": true,
    "page_numbers_in_citations": true
  },
  "doc_types": {
    "base_schema": ["file", "doc_type", "doc_group", "topics", "date_added"],
    "schemas": {
      "<doc_type>": ["<field>", "<field>"]
    },
    "cross_type_join_fields": [
      {
        "label": "<join field label>",
        "mappings": {
          "<doc_type>": "<field name in that doc type>"
        }
      }
    ]
  },
  "chunking": {
    "fallback_chunk_size_lines": 150,
    "max_section_size_lines": 200
  },
  "ingestion_quality": {
    "placeholder_word_threshold": 20,
    "redirect_max_prose_words": 40,
    "navigation_min_links": 5,
    "navigation_max_non_link_words": 30,
    "sibling_summary_similarity_max": 0.85,
    "root_summary_similarity_max": 0.9,
    "semantic_retry_limit": 2,
    "max_nodes_per_semantic_batch": 12,
    "max_content_characters_per_semantic_batch": 30000,
    "node_summary_min_words": 15,
    "node_summary_max_words": 60,
    "root_summary_min_words": 30,
    "root_summary_max_words": 100
  },
  "doc_summary_index": {
    "hierarchy_fields": [
      "doc_group",
      "doc_type",
      "<extension_field>",
      "<extension_field>"
    ],
    "max_nodes": 15
  },
  "query": {
    "max_depth_per_branch": 4,
    "max_nodes_per_query": 25,
    "aggregation_multiplier": 3,
    "output_format": "json | prose"
  }
}
```

`doc_summary_index.hierarchy_fields` shown above is the mixed-vault shape. A homogeneous vault's `hierarchy_fields` typically omits `doc_group`/`doc_type` and starts directly at `["<extension_field>", "<extension_field>", ...]` — see `document-summary-index-schema` for why.

**`ingestion_quality`** — the thresholds the pipeline classifies and validates against. Every field is optional: an absent field takes the default shown above, so a vault onboarded before this block existed needs no migration. `onboard` writes the defaults explicitly so a user can see and change them; post-onboarding changes go through `config-update`. Raising a similarity ceiling or lowering a word minimum is a legitimate tuning decision; there is no way to disable structural or coverage validation, because those are not preferences.

**`schema_version`** — an integer, always the first field, set once by `onboard` and never touched by any other skill except `schema-migration`. Currently `2`. It marks which shape of `config.json`, the Document Summary Index, and tree indexes this vault was built against, so a future format change has something concrete to check against instead of guessing from field presence. A `config.json` written before this field existed has no `schema_version` at all — every skill treats that as version `0`, not as an error. See `global-rules` → "Schema version" for how skills act on it.
<!-- /section -->

---

<!-- section: document-summary-index-schema -->
## Document Summary Index Structure

The Document Summary Index is a navigable tree stored at `.index/document-summary-index.json`. Its hierarchy is determined by `doc_summary_index.hierarchy_fields` in config. The query skill navigates this tree top-down to identify candidate documents.

**Intermediate node** — represents a grouping level (e.g. a doc_group, a doc_type, a company). Contains a summary of all documents in its subtree and child nodes. Never contains `tree_index` — that is only on leaf nodes.

**Leaf node** — represents a single indexed document. Contains all metadata fields for that document plus a prose summary and a pointer to the per-document tree index.

```json
{
  "type": "root",
  "summary": "Index of all documents across all groups and types",
  "children": [
    {
      "type": "intermediate",
      "field": "doc_group",
      "value": "financial",
      "summary": "All financial documents including 10-K and 10-Q filings for Apple and Microsoft",
      "children": [
        {
          "type": "intermediate",
          "field": "doc_type",
          "value": "10-K",
          "summary": "Annual 10-K filings for Apple and Microsoft covering fiscal years 2022–2024",
          "children": [
            {
              "type": "intermediate",
              "field": "company",
              "value": "Apple",
              "summary": "Apple 10-K filings for fiscal years 2022, 2023, and 2024",
              "children": [
                {
                  "type": "leaf",
                  "field": "fiscal_year",
                  "value": "2023",
                  "file": "financial/2023/apple-10k.md",
                  "doc_type": "10-K",
                  "doc_group": "financial",
                  "topics": ["Q1 revenue", "operating expenses", "segment performance"],
                  "date_added": "2026-01-15",
                  "company": "Apple",
                  "fiscal_year": 2023,
                  "period_end_date": "2023-09-30",
                  "summary": "Apple fiscal year 2023 annual filing. Revenue of $383B across iPhone, Services, Mac, iPad and Wearables. Covers competitive risks in smartphone and services markets, EU regulatory exposure, supply chain dependencies, and 2024 management outlook.",
                  "tree_index": "financial_2023_apple-10k.json"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

**Structural rules:**

- `type` is always one of `root`, `intermediate`, or `leaf`
- `root` has no `field` or `value` — it is the single top-level node
- `intermediate` nodes have `field` (the hierarchy field name), `value` (the field value for this grouping), `summary`, and `children`
- `leaf` nodes have all metadata fields, a prose `summary`, and `tree_index` (the filename of the per-document tree index in `.index/trees/`). Leaf nodes never have `children`.
- `summary` on intermediate nodes describes the entire subtree — what documents and topics are grouped under this node. Used by the query skill to decide whether to descend.
- `summary` on leaf nodes is a 2–4 sentence prose description of the document's content — richer than the `topics` field, used for routing open-ended queries that do not map cleanly to metadata fields.
- The hierarchy depth matches the length of `doc_summary_index.hierarchy_fields` in config — this is a configured list, not a fixed shape, and every skill (`rebuild-summary`, `query`, the H2 validator) walks it generically rather than assuming any particular field sits at any particular level. The onboarding convention: for **mixed** vaults, the first two levels are `doc_group` and `doc_type`, since those are the only fields guaranteed to differ across doc types, with extension fields after. For **homogeneous** vaults, `doc_group`/`doc_type` are typically omitted from `hierarchy_fields` entirely — with one value each, they'd only add fixed, non-narrowing hops — and the hierarchy starts directly at the first differentiating extension field. Either way, `doc_group` and `doc_type` are always present on every leaf node as metadata (`base_schema` requires them regardless of vault type); the question is only whether they're *also* dedicated tree levels.
- `tree_index` on leaf nodes is the filename only (not the full path) — the full path is always `.index/trees/<tree_index>`.
<!-- /section -->

---

<!-- section: tree-index-schema -->
## Tree Index Structure

Each per-document tree index follows this pattern. Page range is only present if `source.page_numbers_in_citations` is true in config.

**This structure is generated by `build-tree.js` and is never written by hand.** It is documented here because `query.md` navigates it and `doctor.md` reports on it — not so that any skill can construct one. Every rule below is enforced by the shared validator; none of them are things a skill needs to remember to obey.

```json
{
  "file": "<filename>",
  "doc_type": "<doc_type>",
  "root_summary": "<summary of entire document>",
  "schema_version": 2,
  "source_fingerprint": {
    "line_count": 342,
    "sha256": "<64-character hex digest of the full source file content>"
  },
  "page_range": [1, 42],
  "children": [
    {
      "heading": "<heading text>",
      "level": 1,
      "node_id": "<filename_stem>_<slug of this heading>",
      "summary": "<summary of this section>",
      "page_range": [1, 20],
      "children": [
        {
          "heading": "<subheading text>",
          "level": 2,
          "node_id": "<filename_stem>_<slug of parent heading>_<slug of this heading>",
          "summary": "<summary of this subsection>",
          "page_range": [4, 7],
          "children": [
            {
              "heading": "<sub-subheading text>",
              "level": 3,
              "node_id": "<filename_stem>_<slug>_<slug>_<slug of this heading>",
              "summary": "<summary of this sub-subsection>",
              "page_range": [5, 6],
              "children": [],
              "content_ref": {
                "lines": [145, 189]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

```json
"cross_refs": [
  {
    "type": "intra | inter",
    "raw": "see Note 12",
    "target": "Note 12",
    "resolved_node": "financial_2023_apple-10k_notes_note-12",
    "resolved_file": null
  },
  {
    "type": "inter",
    "raw": "see prior year filing",
    "target": "apple-10k-2022.md",
    "resolved_node": null,
    "resolved_file": "financial/2022/apple-10k-2022.md"
  }
]
```

**Structural rules:**

- `content_ref` appears only on leaf nodes (nodes with no children). Never on non-leaf nodes.
- `page_range` appears on every node at every level including the root, when `source.page_numbers_in_citations` is true in config. When page numbers are not configured, `page_range` is omitted entirely from all nodes.
- `children` is always present. On leaf nodes it is an empty array `[]`.
- `source_fingerprint` appears only on the root node — one fingerprint per document, not per node, since any edit anywhere in the source file can shift line numbers throughout. Computed and compared with exactly this command (never approximated another way, or the comparison is meaningless):
  ```
  node -e "const fs=require('fs');const crypto=require('crypto');const c=fs.readFileSync(process.argv[1],'utf8');console.log(c.split(/\r\n|\r|\n/).length + ' ' + crypto.createHash('sha256').update(c).digest('hex'))" "<path>"
  ```
  Required on every tree index written from `schema_version: 1` onward. A tree index with no `source_fingerprint` at all predates this field — every skill treats that as "staleness unknown," not as an error; see `ingestion.md` and `query.md` for how each side uses it.
- `node_id` appears on every non-root node. The root does not have one — it has no `heading` and is never a cross-reference target. Assigned once, when the node is created during ingestion, never recomputed later. Construction uses `slug(text)` — lowercase; collapse runs of whitespace to a single hyphen; strip any character that isn't `a-z`, `0-9`, or hyphen — applied to the node's own heading and every ancestor heading above it, joined by underscores and prefixed with the tree's filename stem:
  ```
  <filename_stem>_<slug(ancestor_1_heading)>_..._<slug(own_heading)>
  ```
  e.g. `financial_2023_apple-10k_notes_note-12` for the "Note 12" node nested under a "Notes" section in `financial/2023/apple-10k.json`. Underscores are *only* ever level-separators in a `node_id` — `slug()` never produces one — so a `node_id` is unambiguously splittable back into its ancestor chain if needed, though nothing currently relies on that; resolution is always by exact string match (see the peek command below), not by re-parsing the identifier.
- `level` reflects the markdown heading depth: `#` = 1, `##` = 2, `###` = 3, etc. Fallback chunks generated for headerless content or oversized sections use the level of their parent node plus 1.
- `cross_refs` appears on any node — leaf or non-leaf — where cross-reference patterns are detected in that node's content. Omitted entirely when no cross-references exist in the node. Never an empty array — if no cross-references exist, the field is absent.

**Cross-reference field definitions:**

- `type` — `intra` for references within the same document, `inter` for references to another document
- `raw` — the exact text of the cross-reference as it appears in the source
- `target` — the resolved label of what is being referenced (section name, note number, filename)
- `resolved_node` — the target node's own `node_id`, for intra references, if successfully resolved. `null` if unresolved.
- `resolved_file` — the relative file path of the referenced document for inter references, if the target document is indexed. `null` if the target is not indexed or cannot be identified.

**Reading a tree index lazily — the peek command:**

`query.md` never loads a whole tree index at once. It reads one node at a time — either by index path (normal top-down descent) or by `node_id` (a cross-reference jump) — using exactly this command, which prints only the addressed node's own fields plus a *shallow, one-level* view of its immediate children (never their grandchildren):

```
node -e "
const fs = require('fs');
const [file, addrRaw] = [process.argv[1], process.argv[2]];
const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
const shallow = n => ({
  heading: n.heading, level: n.level, summary: n.summary,
  node_id: n.node_id, cross_refs: n.cross_refs, page_range: n.page_range,
  content_ref: n.content_ref, is_leaf: !n.children || n.children.length === 0
});
let addr;
try { addr = JSON.parse(addrRaw); } catch (e) { addr = addrRaw; }
let node;
if (Array.isArray(addr)) {
  node = tree;
  for (const i of addr) node = node.children[i];
} else {
  const find = n => {
    if (n.node_id === addr) return n;
    for (const c of (n.children || [])) { const r = find(c); if (r) return r; }
    return null;
  };
  node = find(tree);
}
if (!node) { console.log(JSON.stringify({ error: 'not found' })); process.exit(0); }
const isRoot = node === tree;
const out = isRoot
  ? { file: node.file, doc_type: node.doc_type, root_summary: node.root_summary, source_fingerprint: node.source_fingerprint, page_range: node.page_range }
  : shallow(node);
out.children = (node.children || []).map(shallow);
console.log(JSON.stringify(out));
" "<path to tree index>" '<address>'
```

Address is either a JSON array of child indices (`[]` for root, `[2]` for `children[2]`, `[2,0]` for `children[2].children[0]`) or a bare `node_id` string for a cross-reference jump. The whole file is parsed inside the Node process either way — that cost is cheap and stays off to the side. What matters for context economy is that only the printed slice (the addressed node plus one level of its children) ever reaches the model; unread branches never do.
<!-- /section -->
