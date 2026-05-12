---
name: modify
description: Re-index a document that has changed or been replaced. Removes the existing tree index and Document Summary Index leaf node, then re-ingests the file from scratch. Use when the user runs /modify or says anything like "re-index this file", "this document has changed", "update the index for this file", "the file was replaced", or "re-ingest this document".
needs: [global-rules, directory-structure]
---

## Step 0 — Load shared context

Read `.claude/skills/docSearch/context.md` in full before proceeding. This file contains the global rules and directory structure that this skill depends on. Required sections: `global-rules`, `directory-structure`.

---

# Modify Skill

You are re-indexing a document that has changed or been replaced under the same filename. This means removing the existing index entries for the document and ingesting it fresh. The source markdown file is read as it currently exists on disk — whatever is there now becomes the new index.

Modify is an orchestrator. It does not build trees or update the Document Summary Index directly. It calls remove then ingestion in sequence, passing state between them cleanly.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:
> "No index configuration found. Please run /docSearch:onboard first."

---

## Step 1 — Resolve the target file

The user will provide a filename or path. Resolve it to the relative path format used in the index (relative to `vault.ingestion_directory`) using the same fuzzy matching logic as the remove skill:

- If the user provides a full relative path, use it directly
- If the user provides just a filename, search the Document Summary Index leaf nodes for matching `file` fields
- If exactly one match is found, confirm it with the user
- If multiple matches are found, list them and ask the user to choose
- If no match is found in the Document Summary Index, check whether the file exists on disk at all

**If the file exists on disk but is not in the index:**
> "`financial/2023/apple-10k.md` is not currently indexed. Did you mean to use /docSearch:ingest instead?"

Wait for the user's response. If they confirm they want to ingest it fresh, hand off to the ingestion skill.

**If the file is in the index but does not exist on disk:**
> "`financial/2023/apple-10k.md` is in the index but the source file no longer exists on disk. This would remove it from the index with nothing to re-ingest. Did you mean to use /docSearch:remove instead?"

Wait for the user's response. If they confirm, hand off to the remove skill.

---

## Step 2 — Confirm the full operation

Show the user exactly what modify will do before doing anything:

> "Modifying `financial/2023/apple-10k.md` will:
> 1. Delete the existing tree index: `.index/trees/financial_2023_apple-10k.json`
> 2. Remove the existing Document Summary Index leaf node
> 3. Re-read the current file from disk and build a new tree index
> 4. Add a new Document Summary Index leaf node
>
> The source file will not be affected. The existing index for this file will be completely replaced.
>
> Confirm? (yes / no)"

Wait for explicit confirmation. Do not proceed on ambiguous responses.

Once confirmed, hold this confirmation state — it will be passed to the remove skill so it does not ask for a second confirmation.

---

## Step 3 — Call remove

Call the remove skill for this file, passing the `confirmed` flag so remove skips its own confirmation step.

If remove fails for any reason, hard stop and report:
> "Modify failed during the remove phase. The file has not been re-ingested. The index state for `<file>` is: `<what succeeded and what failed>`"

Do not proceed to ingestion if remove did not complete successfully. A partial remove followed by a fresh ingestion would leave duplicate or inconsistent state.

---

## Step 4 — Call ingestion

Call the ingestion skill for this file. Pass the resolved file path and the doc type — do not re-ask the user for the doc type. Use the doc type from the entry that was just removed, since the file has not changed type, only content.

If ingestion fails, hard stop and report:
> "Modify failed during the ingestion phase. The old index entry for `<file>` has been removed but the new one could not be built.
>
> To recover: fix the issue reported above, then run `/docSearch:ingest` for `<file>` directly."

Give the user a clear recovery path rather than leaving the index in a state they cannot reason about.

---

## Step 5 — Report completion

```
Modify complete.

✓ Removed old index for: financial/2023/apple-10k.md
✓ Re-ingested: financial/2023/apple-10k.md → 10-K (51 nodes, 4 levels)
✓ Master summary updated

The file has been fully re-indexed.
```

If the node count or structure changed significantly from what the user might expect, note it:
> "Note: the new tree has 51 nodes vs the previous entry — the document structure may have changed."

The previous node count is not stored in the index, so this observation only applies if you have visibility into the old entry before deletion. If you do not, omit this note.

---

## Error handling

**Remove succeeds but ingestion fails:** this is the most important failure case. The old index is gone and the new one does not exist. The Document Summary Index has no leaf node for this file. Report this state clearly and give the explicit recovery command:
> "Run `/docSearch:ingest` for `<file>` once the issue is resolved."

Do not attempt to restore the old tree index — it has been deleted and cannot be recovered. The user must re-ingest.

**Both remove and ingestion fail:** report what remove failed on. Do not attempt ingestion. The original index entry may still be intact depending on where remove failed — tell the user to check the index state with `/docSearch:query` or inspect `.index/` directly.
