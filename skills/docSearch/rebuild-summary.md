---
name: rebuild-summary
description: Rebuild the Document Summary Index from the tree indexes on disk. A recovery tool for when the routing index is missing, corrupted, or out of step with .index/trees/. Trigger when the user runs /rebuild-summary or says "rebuild the routing index", "the document summary index is out of sync", "the index is corrupted", or "restore the index from the trees".
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema, document-summary-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`, `document-summary-index-schema`.

---

# Rebuild-Summary Skill

You are reconstructing the routing index from the tree indexes on disk. This is a **recovery tool**, not part of the normal write path — ingest, modify, sync, and remove each maintain routing themselves as part of their own transaction.

Use it when:

- `document-summary-index.json` is missing while `.index/trees/` still has content
- the routing index cannot be parsed
- `/docSearch:doctor` reports orphaned trees or dangling entries that a targeted fix has not resolved

Trees are the source of truth here. Each one carries the routing payload it was published with, so the rebuild recovers metadata rather than re-deriving it. **No tree is modified by this skill.**

## Step 1 — Preview

```
node {{DOCSEARCH_SCRIPTS}}/rebuild-index.js --dry-run
```

Report what it found before changing anything:

```
Rebuild preview — 270 tree indexes on disk

  ✓ 268 routing entries recoverable in full
  ⚠   2 recoverable but incomplete:
        legacy/notes-2019.md — date_added, fiscal_year unrecovered
  ✗   0 unreadable trees

Resulting routing index: 268 leaves.
```

Two categories need explaining rather than listing:

- **incomplete** — the tree predates routing metadata being stored on trees, so some fields could not be recovered. It will be indexed, with the unrecovered fields null and grouped under `unknown` where a hierarchy field is missing. `/docSearch:modify` on that document restores them properly.
- **skipped** — the tree is unreadable. It will be absent from the rebuilt index entirely. That document becomes unsearchable until `/docSearch:modify` rebuilds it from source.

## Step 2 — Confirm

Say plainly what will be replaced:

> "This replaces `document-summary-index.json` entirely, rebuilding it from the 270 tree indexes on disk. Tree indexes are not modified. The current routing index is backed up first. Proceed?"

## Step 3 — Rebuild

```
node {{DOCSEARCH_SCRIPTS}}/rebuild-index.js
```

The current routing index is backed up, the new one written atomically, then re-read and revalidated. On any failure the backup is restored and nothing changes.

## Step 4 — Report

```
Routing index rebuilt — 268 leaves from 270 trees.

  ⚠ 2 documents have unrecovered metadata → /docSearch:modify
  ✗ 2 trees were unreadable and are not in the index → /docSearch:modify

  Previous index backed up at .index/staging/rebuild-<id>/backup/
```

Then suggest `/docSearch:doctor --deep` to confirm the result, since a rebuild is usually run because something was already wrong.

---

## Error handling

**No trees on disk** — reported as `no_trees`. There is nothing to rebuild from. If the user has sources but no index, the answer is `/docSearch:ingest`, not a rebuild.

**The rebuilt index fails validation** — nothing is written. This means the trees themselves disagree with the configured hierarchy, which usually follows a `hierarchy_fields` change. Run `/docSearch:schema-migration`, or reconsider the config change.

**Rolled back** — the previous routing index is restored intact. Report the reason.

**The user wants to insert or delete one entry** — this skill no longer does targeted edits. Use `/docSearch:ingest`, `/docSearch:modify`, or `/docSearch:remove`, each of which maintains routing transactionally as part of its own operation.
