---
name: sync
description: Reconcile the docSearch Index against the vault directory. Finds files on disk that are not indexed, indexed files whose source has changed, and indexed files whose source is gone, then acts on whichever categories the user confirms. Use when the user runs /sync or says anything like "sync the index", "reconcile my vault", "what has changed since I last indexed", "the index is out of date", or "catch the index up".
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`.

---

# Sync Skill

You are reconciling the vault against the index: what is new, what changed, what disappeared. You produce the diff, the user chooses what to act on, and then you drive the same pipeline the individual skills use. Sync never invents a third way to mutate the index.

## Step 1 — Produce the diff

```
node {{DOCSEARCH_SCRIPTS}}/sync-plan.js
```

Read-only. It compares every Markdown file under `vault.ingestion_directory` against the routing index and each tree's `source_fingerprint`, and classifies every source while it is there.

## Step 2 — Present it

```
Vault: data/ingestion/   (270 files on disk, 258 indexed)

  NEW          14  substantive files not yet indexed
  CHANGED       6  indexed files whose source has changed since indexing
  MISSING       3  indexed documents whose source is gone from disk
  RECLASSIFIED  2  indexed documents that are no longer substantive
  EXCLUDED     11  redirects, placeholders, and navigation pages (not indexed by design)
  UNCHANGED   249

Which would you like to act on?
```

Two categories deserve explicit narration rather than a bare count:

- **RECLASSIFIED** — a document that was substantive when indexed and now classifies as a redirect, placeholder, or navigation page. Name each one and what it became. Acting on these removes them from the index; that is usually right, but it is a content decision the user should make knowingly.
- **UNCHANGED with unknown staleness** — documents indexed before fingerprinting existed. `sync-plan.js` reports these as `staleness: unknown` rather than pretending they are current. Offer to re-index them; do not silently count them as fine.

Let the user pick categories independently. "Just the new ones" is a common and reasonable answer.

## Step 3 — Act

Each category maps to an existing flow. Run them in this order, because it keeps the index consistent at every intermediate point:

1. **MISSING and RECLASSIFIED** → `remove-document.js`, one invocation carrying every `--file`. One transaction, not one per document.
2. **CHANGED** → the modify flow: build skeletons, queue, results, merge, then `publish-batch.js --mode modify`. All changed documents go through one publication.
3. **NEW** → the ingest flow, ending in `publish-batch.js --mode ingest`. One publication for the whole set.

Within each group, batch the work rather than looping per document. The routing index is written once per group, not once per file — that is the property that makes a large sync safe and fast.

Confirm before each publication step, naming what it will change.

## Step 4 — Report

```
Sync complete.

  ✓ 14 new documents indexed
  ✓  6 documents re-indexed
  ✓  3 removed (source no longer on disk)
  ✓  2 removed (reclassified as redirect)
  ✗  0 failures

  Routing index: 269 leaves.
```

Report each group's outcome separately. A failure in one group does not invalidate the others — say which groups succeeded rather than reporting the whole sync as failed.

---

## Error handling

**A group's publication rolls back** — that group's changes are entirely absent; the others stand. Report which group and quote `rollback_reason`.

**A document fails semantic validation during the CHANGED or NEW group** — it is left out of that group's publication and reported. Its previous index entry, if any, is untouched.

**The vault directory does not exist** — reported as `no_ingestion_dir`. The configured path may be wrong; direct the user to `/docSearch:config-update`.

**A very large diff** — warn before acting when a group exceeds a few hundred documents, and offer to act on a subdirectory first. Nothing breaks at scale, but a user should not discover the runtime by accident.
