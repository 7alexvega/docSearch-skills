---
name: ingestion
description: Add documents to the docSearch Index. Builds a tree index for each markdown file and updates the Document Summary Index. Use when the user runs /ingest or says anything like "add this file to the index", "index this document", "ingest this directory", "add these files to the index", or "index my vault". Accepts a single file path, a list of file paths, or a directory path.
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Ingestion Skill

You are orchestrating a deterministic pipeline. **You do not build tree indexes.** Scripts parse the source, decide the tree shape, assign node ids, compute line ranges and page ranges, and validate the result. Your only creative work is writing summaries and extracting metadata, and even those are checked mechanically before anything is published.

This division is the point. Structural defects — a missing `children` array, an overlapping line range, a malformed cross-reference — are not things to be careful about. They are things you cannot cause, because you never hold the pen for those fields.

Run every script with `node`. All of them print a single JSON object to stdout and use exit codes: `0` success, `1` the operation ran but its subject failed, `2` it could not run. Read the JSON; do not infer from exit codes alone.

## Before anything else

Every script reads `.index/config.json` itself and fails with a clear message if it is absent, so there is no separate config-loading step. If any script reports `no_config`, stop and tell the user to run `/docSearch:onboard`.

---

## Step 1 — Scan and classify

```
node {{DOCSEARCH_SCRIPTS}}/scan-vault.js --input <path> [--input <path> ...]
```

Use `--all` instead of `--input` when the user asks to ingest the whole vault. Pass a directory to ingest everything beneath it.

This resolves paths, confirms every input falls under `vault.ingestion_directory`, enumerates Markdown files in a deterministic order, fingerprints each one, and classifies each source as `substantive`, `redirect`, `placeholder`, `navigation_only`, or `unsupported`.

Hold `run_id` from the output. Everything below writes under `.index/staging/<run_id>/`.

## Step 2 — Present the plan and confirm

Report what the scan found before doing any work:

```
Scanned 238 files under traefik3-docs/

  198  substantive      → will be indexed
   31  redirect         → recorded as aliases, not indexed separately
    7  placeholder      → excluded (too little content to answer a query)
    2  navigation_only  → excluded (link lists with no answerable content)

  12 already indexed — use /docSearch:modify to re-index those.

Proceed with 198 documents?
```

Redirects, placeholders, and navigation pages being excluded is the normal, desired outcome — say so plainly rather than reporting them as failures. If the user disagrees with a classification, the thresholds are configurable through `/docSearch:config-update` under `ingestion_quality`.

If any file has no doc type mapping, collect them all and ask once, showing the doc types from config. Never invent a doc type.

## Step 3 — Build tree skeletons

For each substantive document:

```
node {{DOCSEARCH_SCRIPTS}}/build-tree.js --source <absolute path> --doc-type <type> \
  --out .index/staging/<run_id>/trees/<tree_index>.json
```

These are independent per file and safe to run concurrently — each writes only its own output. Where your runtime offers parallel execution, use it. Where it does not, run them in sequence; the result is identical either way.

Every tree comes out with `summary: null` on every node and `root_summary: null`. That is expected — Step 5 fills them in.

A file that exits non-zero here is a parse or validation failure. Record it as `failed_parse`, drop it from the run, and continue with the rest.

## Step 4 — Build the semantic queue

```
node {{DOCSEARCH_SCRIPTS}}/build-semantic-queue.js \
  --tree-dir .index/staging/<run_id>/trees \
  --out-dir .index/staging/<run_id>/semantic-queue
```

This produces `batch-001.json`, `batch-002.json`, … Each batch is self-contained: it carries the tasks, each task's content, the document's full heading outline, each node's sibling headings, the word limits, and the output schema.

## Step 5 — Produce summaries

For each batch file, produce a matching results file at `.index/staging/<run_id>/semantic-results/<batch-id>.json`.

A batch is pure text in, text out. It touches no files, reads nothing else, and makes no structural decisions — so it can be handled by a sub-agent, by several sub-agents in parallel, or by you directly in sequence, whichever your runtime supports. Do not give a worker any capability beyond producing its results file.

Write the results in exactly the shape the batch's `output_schema` specifies:

```json
{
  "batch_id": "batch-001",
  "results": [
    { "task_id": "…", "summary": "…", "topics": ["…"] },
    { "task_id": "…:__root__", "summary": "…", "topics": ["…"], "metadata": { "product": "Traefik Proxy v3" } }
  ]
}
```

**Write only `task_id`, `summary`, `topics`, and `metadata`.** Any other field is discarded and reported. You cannot alter the tree by writing to a results file, so do not try — fix structural problems by fixing the source or the config, never by hand-editing an index.

What makes a summary pass:

- **Node summaries: 15–60 words. Root summaries: 30–100 words.**
- Name concrete things actually present in the supplied content — settings, commands, error codes, entities, figures, constraints.
- Add information the heading does not already carry.
- Be distinguishable from the sibling headings listed on the task. That is why siblings are supplied.
- Claim nothing the content does not support.

What gets rejected: openings like "Documentation covering…", "This section discusses…", "This document contains information about…"; bare restatements of the heading; and summaries too similar to a sibling's.

For root tasks, also extract every field in `required_metadata`. Set a field to `null` rather than guessing — a null is reported to the user and fixable; a wrong value is silent.

## Step 6 — Merge and validate

```
node {{DOCSEARCH_SCRIPTS}}/merge-semantic-results.js \
  --tree-dir .index/staging/<run_id>/trees \
  --results-dir .index/staging/<run_id>/semantic-results \
  --out-dir .index/staging/<run_id>/merged
```

This folds summaries into the skeletons, proves the structure is unchanged, revalidates against the source, and applies the quality rules. It also writes `merged/leaves.json`, the routing entries for every document that passed.

On exit `1`, read `retry_tasks`. Each entry names a `task_id` and the specific reasons it failed. **Rebuild only those tasks**, with the reasons included alongside the original content, and write a corrected results file. Then re-run the merge.

Retry at most `ingestion_quality.semantic_retry_limit` times (default 2). After that, mark the affected documents `failed_semantic_validation`, leave them unpublished, and continue with the rest. A document that cannot earn a usable summary is worse than absent — it pollutes routing for every future query.

## Step 7 — Publish

```
node {{DOCSEARCH_SCRIPTS}}/publish-batch.js \
  --merged-dir .index/staging/<run_id>/merged \
  --leaves .index/staging/<run_id>/merged/leaves.json \
  --backup-dir .index/staging/<run_id>/backup \
  --mode ingest
```

Add `--dry-run` first if the user asked to preview, or if this run is large enough that a surprise would be costly.

Publication revalidates everything from scratch, backs up every file at risk, moves the trees into `.index/trees/`, replaces the routing index exactly once, then re-reads both to verify. If verification fails it restores everything and reports why. There is no partial-publication state to clean up afterwards.

Per `global-rules`, confirm with the user before this step unless they have already approved the run.

## Step 8 — Report

Report every document's terminal state. A document counts as indexed only if it appears in `published`.

```
Ingestion complete.

  ✓ 196 documents indexed
  ⊘  31 redirects recorded as aliases
  ⊘   9 excluded (placeholder or navigation-only)
  ✗   2 failed semantic validation after 2 retries:
        traefik3-docs/observability.md — summaries too similar to siblings
        traefik3-docs/migration.md — root summary too generic

  ⚠ 3 documents have null metadata fields:
        traefik3-docs/api.md — product
        …

Routing index updated: 196 leaves.
```

If publication rolled back, say so explicitly and quote `rollback_reason`. The index is unchanged in that case — nothing was half-applied.

---

## Error handling

**A script exits `2`** — it could not run at all. The JSON carries `error.code`; common ones are `no_config`, `outside_ingestion_dir`, `source_missing`, and `no_page_markers`. Report the message as-is and stop; these are user-fixable conditions, not things to work around.

**A single document fails** — drop it from the run and continue. Report its terminal state in Step 8.

**Publication reports `rolled_back: true`** — the index is exactly as it was before the run. Report the reason. The staged artifacts remain under `.index/staging/<run_id>/` for inspection.

**Anything suggests hand-editing `.index/`** — it is wrong. Every mutation goes through these scripts. Use `/docSearch:doctor` to inspect.
