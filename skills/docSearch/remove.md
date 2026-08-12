---
name: remove
description: Remove a document from the docSearch Index. Deletes its tree index and its Document Summary Index entry in a single verified transaction. Use when the user runs /remove or says anything like "remove this from the index", "delete this document from the index", "unindex this file", "this file is gone", or "clean up the entry for X".
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`.

---

# Remove Skill

You are removing one or more documents from the index. Removal is transactional: the next routing index is built and validated before anything is displaced, tree files are moved to a backup rather than deleted, and everything is restored if verification fails.

Removing a document does not touch its source Markdown file. Say so when confirming, so nobody believes this deletes their work.

## Step 1 — Preview

```
node {{DOCSEARCH_SCRIPTS}}/remove-document.js --file <relative path> [--file <another>] --dry-run
```

Paths are relative to `vault.ingestion_directory` — the same form the `file` field takes throughout the index. If the user gives an absolute path or a bare filename, resolve it against the vault first; if it is ambiguous, ask rather than guessing.

The dry run reports what would be removed and how many routing leaves would remain. Nothing is touched.

## Step 2 — Confirm

Show exactly what will happen:

```
Remove from the index:

  financial/2023/apple-10k.md   (tree: financial_2023_apple-10k.json)

The source Markdown file is not deleted — only its index entries.
Remaining indexed documents: 269

Proceed?
```

## Step 3 — Remove

```
node {{DOCSEARCH_SCRIPTS}}/remove-document.js --file <relative path> [--file <another>]
```

The tree file is moved into the run's backup directory, not deleted, so a failed verification can put it back — and so a user who changes their mind within the session can recover it.

## Step 4 — Report

```
Removed 1 document.

  ✓ financial/2023/apple-10k.md

  Routing index: 269 leaves remaining.
  Tree preserved at .index/staging/remove-<id>/backup/trees/financial_2023_apple-10k.json
  Delete that directory once you are satisfied.
```

If the run reports `rolled_back: true`, the index is exactly as it was. Report the reason.

---

## Error handling

**No routing entry matches the file** — reported as `ok: false` with `not_found`. The document may already be removed, or the path may be wrong. Suggest `/docSearch:doctor` to see what is actually indexed.

**The next routing index fails validation** — nothing is removed. This indicates existing damage in the index rather than a problem with the removal; run `/docSearch:doctor` and follow what it reports.

**Dangling cross-references afterwards** — other documents may reference the removed one. This is not an error and does not block anything; `query` handles unresolvable cross-references gracefully. `/docSearch:doctor --deep` lists them if the user wants to review.
