# docSearch

docSearch is a set of skills for Claude Code and Codex to implement vectorless hierarchical search over a collection of markdown files.

What about PDFs?

This system is intended to be used with markdown files. Existing documents such as PDFs can be converted to md files using docling.

No embeddings. No vector database. These skills build a two-tier index system that LLMs can navigate top-down, reading only the relevant files and source line ranges it actually needs. When setup you can query your collection of markdown files and every answer returns with a full citation trail back to the file, section, line range, and (when configured) page numbers in the original PDF.

docSearch is Designed for homogeneous vaults (one document type, like a folder of 10-K filings) and mixed vaults (financial filings, qualitative reviews, technical docs, and so on, queried together with cross-type joins).

## How it works

Vectorless RAG utilizes tree index structures. The indexes are internal navigation state for LLMs. You interact with it normally, by asking questions.

The index lives at `.index/` in the project root. It has two tiers.

### Structure is generated, not written by a model

Index structure — tree shape, node ids, line ranges, page ranges, coverage, the routing index — is produced by dependency-free Node scripts that ship with the package. A model's only writable surface is the summaries and the document metadata, and those are validated mechanically before anything is published.

This matters because structural defects do not fail loudly. A malformed tree index does not crash; it silently degrades retrieval weeks later, in a way that looks like a bad answer rather than bad JSON. Taking the pen away from the model removes that failure mode rather than trying to catch it.

It also means Claude and Codex produce identical artifacts. Earlier versions enforced structure with Claude Code hooks, which covered only half the install matrix and only the write paths they happened to intercept. Validation now lives in the pipeline itself, so it applies on every runtime, and applies equally whether a skill, a shell, or CI invokes it.

Every mutation is staged, validated, backed up, published atomically, then re-read and verified — and rolled back in full if verification fails. There is no partial-write state to clean up.

### Tier 1: Document Summary Index

A navigable tree grouped by hierarchy fields you choose during onboarding. The first two levels are always `doc_group` (financial, legal, technical, research, qualitative, operational, general) and `doc_type` (the specific format, like `10-K` or `user_reviews`). The levels after that are yours: `company`, `fiscal_year`, `product`, `version`, whatever narrows your queries fastest.

Each intermediate node carries a summary of its subtree, so the query skill can decide whether to descend without reading any documents. Each leaf node carries the document's metadata and a 2 to 4 sentence prose summary, plus a pointer to its tree index.

### Tier 2: Per-document tree indexes

One JSON file per document at `.index/trees/<document>.json`. Mirrors the markdown heading hierarchy: each `#`, `##`, `###`, `####` becomes a node. Files without headings are split into fixed-size chunks. Long sections that exceed `max_section_size_lines` are auto-split into sub-chunks.

Every node has a summary. Every leaf has a `content_ref` pointing at a line range in the source markdown. Cross-references inside the text (`see Note 12`, `refer to prior year filing`) are detected and resolved at ingestion time, so the query skill can follow them within or across documents.

### Query flow

When querying your documents the LLM:

1. Classifies the query: single-document lookup, cross-document aggregation, cross-type analytical, or ambiguous.
2. Uses the Document Summary Index to decide which documents are needed to answer the query.
3. For each candidate document, walk its respective tree index.
4. Synthesizes an answer, attaching a citation trail reflecting how it arrived to that answer (file, section, line range, and page numbers).

## Getting started

### Install

```
npx docsearch-skills@latest
```

The installer is interactive and prompts for a runtime (claude code or codex):

### First run

When your documents (see [Other Useful tools](#other-useful-tools) ) are ready do the run the following skills first:

1. `onboard`. Guided questioning to help setup tree indexes: vault source and document types, metadata schema per doc type, Document Summary Index hierarchy and node budget, chunking and query limits. Nothing is written to disk until you confirm the full config at the end.
2. `ingest`. Pass a single file, a list of files, or a directory. It reports what it found before doing any work — including which pages it classified as redirects, placeholders, or navigation and will therefore exclude — and asks before publishing anything.
3. `query`. Ask any question about the ingested files.

If anything behaves oddly, run the install check first. It verifies the scripts are reachable, Node is new enough, the config parses, and the vault is writable:

```
node .claude/docsearch/scripts/selftest.js      # Claude, local install
node .codex/docsearch/scripts/selftest.js       # Codex, local install
```

## Commands

Ten skills. Invoked as `/docSearch:<name>` in Claude Code or `docSearch-<name>` in Codex.

| Command            | Description                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboard`          | First-time setup. Configures vault, doc types, metadata schema, hierarchy, chunking, and query limits. Writes `config.json` and initializes the `.index/` directory. Required before any other skill runs.                                                                                                                               |
| `ingest`           | Adds documents to the index. Accepts a single file, a list, or a directory. Classifies each source, builds a deterministic tree index per document, generates and validates summaries, then publishes trees and routing entries in one verified transaction. Redirect, placeholder, and navigation-only pages are excluded by design and reported. Use `modify` to re-index something already indexed. |
| `query`            | Answers a question from the index. Classifies the query, navigates the Document Summary Index for candidates, walks each candidate's tree index for relevant leaves, retrieves only the necessary line ranges, and synthesizes an answer with a citation trail. Returns JSON or prose per config. Pass `--deep` to double all budgets, `--verify` to force a blind citation-faithfulness check (runs automatically when confidence comes out partial/low or the query is cross-type).                        |
| `modify`           | Re-indexes a file that changed on disk. A single transaction — the replacement is built and validated in staging before the old entry is displaced, so a failure never leaves the document missing. Also the upgrade path for documents indexed by an older pipeline version.                                                       |
| `remove`           | Removes a document from the index. Builds and validates the next routing index, backs up everything at risk, then publishes and verifies. Tree files are moved to a backup rather than deleted. The source markdown is untouched.                                                                                                    |
| `rebuild-summary`  | Rebuilds the Document Summary Index from the tree indexes currently on disk. A recovery tool for when the routing index is missing, corrupted, or out of step with `.index/trees/`. Trees carry their own routing metadata, so the rebuild recovers it rather than re-deriving it. Tree indexes are never modified.                 |
| `config-update`    | Changes any setting in `config.json`. Detects whether the change affects the schema; if so, recommends running `schema-migration` afterward. Changing the Document Summary Index hierarchy order requires a full index rebuild.                                                                                                          |
| `schema-migration` | Updates existing Document Summary Index leaf nodes after a schema change. Always run via this skill, never by hand.                                                                                                                                                                                                                      |
| `doctor`           | Read-only health check of the index. Default mode reads the Document Summary Index and a directory listing for cheap checks (document counts, orphaned or dangling entries, unknown groupings, null metadata); `--deep` also parses every tree index, confirms source files still exist, and flags stale ones. Never repairs anything itself. |
| `sync`             | Reconciles the index against the vault directory: files on disk but not indexed, indexed files that changed since ingestion (via the staleness fingerprint), and indexed files whose source is gone. Reports the diff, then delegates to `ingest`/`modify`/`remove` per category after confirmation.                                   |

## Configuration

All settings live in `.index/config.json`. Never edit it manually. Use `config-update`.

### `vault`

| Field                    | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `type`                   | `homogeneous` or `mixed`.                                                 |
| `ingestion_directory`    | Absolute path for the markdown files root.                                |
| `doc_type_path_mappings` | Which subdirectory under the ingestion directory contains which doc type. |

### `source`

| Field                       | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `docling_used`              | True if PDFs were converted with Docling before ingestion. |
| `page_numbers_present`      | Whether the markdown contains page markers.                |
| `page_numbers_in_citations` | Whether to include page numbers in citation output.        |

### `doc_types`

| Field                    | Description                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_schema`            | Fixed at `file`, `doc_type`, `doc_group`, `topics`, `date_added`.                                                                                         |
| `schemas`                | Per-type extension fields. For a 10-K: `company`, `fiscal_year`, `period_end_date`. For user reviews: `source`, `subject`, `period`, `sentiment_summary`. |
| `cross_type_join_fields` | In mixed vaults, fields that mean the same thing under different names across types. Required for cross-type queries to join correctly.                   |

### `chunking`

| Field                       | Default | Description                                               |
| --------------------------- | ------- | --------------------------------------------------------- |
| `fallback_chunk_size_lines` | 150     | Chunk size for files with no headings.                    |
| `max_section_size_lines`    | 200     | Split sections longer than this even if a heading exists. |

### `ingestion_quality`

The thresholds ingestion classifies and validates against. Every field is optional — an absent field takes its default, so an older config needs no migration.

| Field                                       | Default | Description                                                                                       |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `placeholder_word_threshold`                | 20      | Below this many prose words, with no code, a page is a placeholder and is excluded.               |
| `redirect_max_prose_words`                  | 40      | A short page pointing at another local document becomes an alias instead of its own entry.        |
| `navigation_min_links`                      | 5       | With at least this many links and little text outside them, a page is navigation and is excluded. |
| `navigation_max_non_link_words`             | 30      | The "little text" half of that rule.                                                              |
| `node_summary_min_words` / `_max_words`     | 15 / 60 | Length bounds for section summaries.                                                              |
| `root_summary_min_words` / `_max_words`     | 30 / 100 | Length bounds for document summaries.                                                            |
| `sibling_summary_similarity_max`            | 0.85    | Sibling sections whose summaries are more alike than this are rejected and rewritten.             |
| `root_summary_similarity_max`               | 0.9     | The same rule across documents.                                                                   |
| `semantic_retry_limit`                      | 2       | Regeneration attempts before a document is left out of the index.                                 |
| `max_nodes_per_semantic_batch`              | 12      | Work-batch size.                                                                                  |
| `max_content_characters_per_semantic_batch` | 30000   | Work-batch character budget.                                                                      |

Structural correctness and complete source coverage are always enforced and have no setting. A document whose content is not fully reachable by some query is a defect, not a preference.

### `doc_summary_index`

| Field              | Default | Description                                                                                                         |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `hierarchy_fields` | --      | Order matters. First two are always `doc_group` and `doc_type`. Put the field that narrows most aggressively first. |
| `max_nodes`        | 15      | Navigation budget for the Document Summary Index.                                                                   |

### `query`

| Field                    | Default | Description                                                                                           |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------- |
| `max_depth_per_branch`   | 4       | How deep to descend in any single tree.                                                               |
| `max_nodes_per_query`    | 25      | Total node read budget across all trees.                                                              |
| `aggregation_multiplier` | 3       | Multiplier applied automatically for cross-document aggregation queries (giving 75 nodes by default). |
| `output_format`          | --      | `json` or `prose`.                                                                                    |

## Other useful tools

### `convert_pdfs_to_markdown.py`

A companion Python script available in this repo.

What it does: converts a directory of PDFs to markdown files using [Docling](https://github.com/docling-project/docling), splitting each PDF into single pages with `pypdf` and converting them independently. The resulting markdown for each document is reassembled with explicit page markers:

```
<!-- page:1 -->
## Page 1

...content...

<!-- page:2 -->
## Page 2

...content...
```

These markers are what the `onboard` skill detects when asked if docling was used. The same markers feed the `page_range` field on every tree index node, so citations from `query` can include exact pages from the original PDF.

Usage:

```
uv run convert_pdfs_to_markdown.py \
  --input-dir data/raw-pdfs \
  --output-dir data/ingestion/<doc-type>
```

Useful flags:

- `--force`: overwrite existing `.md` outputs (default skips them, so the script is resumable).
- `--pdf <name>`: convert only the named PDF. Can be repeated.
- `--limit N`: convert at most N files. Good for a smoke test.
- `--workers N`: parallel worker count (default `min(6, cpu_count)`). Set to 1 to disable multiprocessing.

If `--input-dir`, `--output-dir`, or `--workers` are omitted, the script prompts interactively.

First-run note: Docling downloads model weights (hundreds of MB) the first time it runs, and PDF conversion is CPU-heavy. Expect long initial conversions for large documents.

### Obsidian

[Obsidian](https://obsidian.md/) is a personal notetaking app that utilizes markdown files. In this context it can be a good tool to view and read ingested markdown files as well as verifying citation trails. Additionally Obsidian has useful plugins and extensions

### Obsidian Web Clipper

[Obsidian Web Clipper](https://obsidian.md/clipper) is a browser extension for Chrome and Firefox that captures webpages as clean markdown into an Obsidian vault. It can be configured to directly added content into your ingestion directory and be ready for the `ingest` skill. You may have to do some cleaning as the conversions are not always perfect

## Suggested setup

```
my-vault/                       project root; run Claude Code or Codex here
  data/                         open this as the Obsidian vault
    raw-pdfs/                   PDFs you want to convert
    ingestion/                  markdown sources, organized by doc type
      <doc-type>/
  .index/                       generated; navigation state, do not edit by hand
    config.json
    document-summary-index.json routing index
    aliases.json                redirect paths → canonical documents
    trees/                      one tree index per document
    staging/<run-id>/           per-run working state, backups, transaction log
  .claude/ or .codex/           installed by npx docsearch-skills@latest
    commands|skills/            the skills themselves
    docsearch/scripts/          the pipeline
```

Open `data/` as the Obsidian vault. Run Claude Code or Codex from `my-vault/` (the project root), not from `data/`. The `.index/` directory and the installed skills sit outside the Obsidian vault, so they do not pollute search or graph view.

Typical workflow:

1. Drop PDFs into `data/raw-pdfs/`. Convert the pdfs into markdown files using your tool of choice.
2. Capture web pages or articles with Obsidian Web Clipper directly into `data/ingestion/<doc-type>/`. Or write your own markdown files
3. Once, from the project root, run `onboard`. Point `ingestion_directory` at `data/ingestion/`. Define your doc types, hierarchy, and limits.
4. Whenever you add new sources, run `ingest` on the new files or directories.
5. Run `query` to ask questions. Every answer comes with citations. Open Obsidian and follow the citation to verify against the markdown source, or open the matching PDF in `data/raw-pdfs/` to verify against the original.

Citations are the verification mechanism. Use them.

## Next steps

For a more pesonalized setup you could build a local only web frontend for browsing the index, walking citation trails, and previewing source markdown or PDFs in place.

## License

MIT License. See [LICENSE](LICENSE) for details
