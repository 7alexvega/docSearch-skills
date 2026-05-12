# docSearch Shared Context

This file is the single source of truth for all shared vocabulary, rules, directory structure, and JSON schemas used across the docSearch skill suite. Every skill reads this file in Step 0 before doing anything else.

---

<!-- section: global-rules -->
## Global Rules

These rules apply to every skill without exception.

### Config first

Every skill must read `.index/config.json` as its first action before doing anything else. The `.index/` directory is always at the repository root — the current working directory where Claude Code is running. If `.index/config.json` does not exist at `<cwd>/.index/config.json`, hard stop with:

> "No index configuration found. Please run /docSearch:onboard first."

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

### Skills call skills

Modify calls Remove then Ingest internally. Ingest calls Rebuild-summary internally. Remove calls Rebuild-summary internally. Schema-migrate is called by Config-update when schema changes are detected. These internal calls are transparent — the skill reports what it is doing at each step.
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

```
repository root/        ← current working directory where Claude Code runs
  .claude/
    skills/
      docSearch/
        context.md      ← shared context (this file)
        onboarding/
        ingestion/
        ...
  .index/               ← always here, always at repository root
    config.json
    document-summary-index.json
    trees/
      <document-name>.json
      ...
```

The `.index/` directory is always at the repository root — the current working directory where Claude Code is running. Every skill locates `.index/` relative to the current working directory without reading context first. This means any skill can hard stop immediately if `.index/config.json` is not found at `<cwd>/.index/config.json`.
<!-- /section -->

---

<!-- section: config-schema -->
## Config.json Structure

All skills read and write config using this exact structure. No skill adds fields not defined here without a corresponding /docSearch:config-update or /docSearch:onboard run.

```json
{
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
- The hierarchy depth matches the length of `doc_summary_index.hierarchy_fields` in config. The first two levels are always `doc_group` and `doc_type`. Subsequent levels are extension fields in the order defined in config.
- `tree_index` on leaf nodes is the filename only (not the full path) — the full path is always `.index/trees/<tree_index>`.
<!-- /section -->

---

<!-- section: tree-index-schema -->
## Tree Index Structure

Each per-document tree index follows this pattern. Page range is only present if `source.page_numbers_in_citations` is true in config.

```json
{
  "file": "<filename>",
  "doc_type": "<doc_type>",
  "root_summary": "<summary of entire document>",
  "page_range": [1, 42],
  "children": [
    {
      "heading": "<heading text>",
      "level": 1,
      "summary": "<summary of this section>",
      "page_range": [1, 20],
      "children": [
        {
          "heading": "<subheading text>",
          "level": 2,
          "summary": "<summary of this subsection>",
          "page_range": [4, 7],
          "children": [
            {
              "heading": "<sub-subheading text>",
              "level": 3,
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
    "resolved_node": "notes_note-12",
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
- `level` reflects the markdown heading depth: `#` = 1, `##` = 2, `###` = 3, etc. Fallback chunks generated for headerless content or oversized sections use the level of their parent node plus 1.
- `cross_refs` appears on any node — leaf or non-leaf — where cross-reference patterns are detected in that node's content. Omitted entirely when no cross-references exist in the node. Never an empty array — if no cross-references exist, the field is absent.

**Cross-reference field definitions:**

- `type` — `intra` for references within the same document, `inter` for references to another document
- `raw` — the exact text of the cross-reference as it appears in the source
- `target` — the resolved label of what is being referenced (section name, note number, filename)
- `resolved_node` — the node identifier within the same tree index for intra references, if successfully resolved. `null` if unresolved.
- `resolved_file` — the relative file path of the referenced document for inter references, if the target document is indexed. `null` if the target is not indexed or cannot be identified.
<!-- /section -->
