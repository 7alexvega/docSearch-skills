---
name: modify
description: Re-index a document that has changed on disk. Rebuilds its tree index and updates its Document Summary Index entry in a single transaction. Use when the user runs /modify or says anything like "re-index this file", "this document changed", "update the index for X", "refresh this document", or "I edited a file that is already indexed".
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`, `tree-index-schema`.

---

# Modify Skill

You are replacing one document's index entry with a freshly built one.

**This is a single transaction, not a remove followed by an ingest.** The old approach left the document absent from the index in between, so a failure halfway through silently deleted it. Here the replacement is built and validated in staging first, and the old entry is only displaced once the new one is proven good.

Modify is also the upgrade path for documents indexed under an older pipeline version: re-indexing regenerates the tree under current rules and gives it a `source_fingerprint`, which is why `doctor` recommends it for stale and unverified documents.

## Step 1 — Confirm the document is indexed

```
node {{DOCSEARCH_SCRIPTS}}/sync-plan.js
```

Find the target in the output. If it appears under `to_ingest` it is not indexed yet — tell the user to run `/docSearch:ingest` instead. If it appears under `to_remove` because the source is gone, tell them to run `/docSearch:remove`.

If the user names a file that appears under `unchanged`, say so and ask whether to re-index anyway. Re-indexing an unchanged file is legitimate — it regenerates summaries under current quality rules — but it should be a deliberate choice, not an accident.

## Step 2 — Build the replacement in staging

Pick a run id, then run the pipeline exactly as `ingestion.md` Steps 3 through 6 describe:

1. `build-tree.js` → `.index/staging/<run_id>/trees/`
2. `build-semantic-queue.js` → `.index/staging/<run_id>/semantic-queue/`
3. produce results → `.index/staging/<run_id>/semantic-results/`
4. `merge-semantic-results.js` → `.index/staging/<run_id>/merged/`

The summary rules and the retry loop are identical. Nothing about a single-document run changes them.

## Step 3 — Publish in modify mode

```
node {{DOCSEARCH_SCRIPTS}}/publish-batch.js \
  --merged-dir .index/staging/<run_id>/merged \
  --leaves .index/staging/<run_id>/merged/leaves.json \
  --backup-dir .index/staging/<run_id>/backup \
  --mode modify
```

`--mode modify` is what permits replacing an existing entry; `ingest` mode refuses it. The engine backs up both the current tree and the current routing index, replaces both, re-reads them, and restores everything if verification fails.

Confirm with the user before this step.

## Step 4 — Report

```
Re-indexed traefik3-docs/setup-docker.md

  Nodes:    47 → 52
  Coverage: 100%
  Routing index updated.

  Previous tree backed up at .index/staging/<run_id>/backup/trees/
```

Report node counts from the new tree and, when the old one is available in the backup, the change. If publication rolled back, say so and quote `rollback_reason` — the index is unchanged in that case.

Flag any null metadata fields the merge reported, naming the field and the file.

---

## Error handling

**Merge keeps failing after the retry limit** — the document is left untouched. Report which quality rules it could not satisfy. This usually means the source itself is thin; check whether it should be indexed at all.

**Publication rolled back** — the index is exactly as it was. The staged artifacts remain under `.index/staging/<run_id>/` for inspection.

**The source no longer exists** — use `/docSearch:remove`, not modify.
