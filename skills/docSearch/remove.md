---
name: remove
description: Remove a document from the docSearch Index. Deletes the tree index file and removes the leaf node from the Document Summary Index. Use when the user runs /remove or says anything like "remove this document from the index", "delete this file from the index", "unindex this document", or "take this out of the index".
needs: [global-rules, directory-structure, config-schema]
---

## Step 0 — Load shared context

Read `.claude/skills/docSearch/context.md` in full before proceeding. This file contains the global rules, directory structure, and config schema that this skill depends on. Required sections: `global-rules`, `directory-structure`, `config-schema`.

---

# Remove Skill

You are removing a document from the docSearch Index. This means deleting its tree index JSON from `.index/trees/` and removing its leaf node from `document-summary-index.json`. The source markdown file is never touched — only index files are affected.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:

> "No index configuration found. Please run /docSearch:onboard first."

---

## Step 1 — Resolve the target file

The user will provide a filename or path. Resolve it to the relative path format used in the index (relative to `vault.ingestion_directory`).

If the user provides just a filename without a path (e.g. `apple-10k.md` instead of `financial/2023/apple-10k.md`), search `document-summary-index.json` for leaf nodes whose `file` field ends with that filename.

- If exactly one match is found, confirm with the user before proceeding:

  > "Found `financial/2023/apple-10k.md`. Is this the document you want to remove?"

- If multiple matches are found, list them and ask the user to specify:

  > "Multiple indexed documents match `apple-10k.md`:
  >
  > 1. `financial/2023/apple-10k.md`
  > 2. `financial/2024/apple-10k.md`
  >
  > Which do you want to remove?"

- If no match is found in the Document Summary Index, check whether a tree index file exists for it anyway. If a tree index exists but has no Document Summary Index leaf node, tell the user and ask whether to delete the orphaned tree index. If neither exists, hard stop:
  > "`apple-10k.md` was not found in the index. Nothing to remove."

---

## Step 2 — Check for dangling cross-references

Before confirming deletion, scan all other tree indexes in `.index/trees/` for any nodes that contain `inter` cross-references pointing to this document. Check the `resolved_file` field of every `cross_refs` entry across all tree indexes.

This scan can be done efficiently by searching for the relative file path string in all tree index JSON files rather than fully parsing each one.

If any other indexed documents reference the document being removed, warn the user:

> "⚠ The following indexed documents contain cross-references to `<file>`:
>
> - `financial/2024/apple-10k.md` (1 reference)
> - `financial/2023/microsoft-10k.md` (2 references)
>
> Removing `<file>` will leave these references unresolvable. The query skill will note them as dangling when encountered. The referencing documents do not need to be re-ingested unless you want the cross-references removed from their tree indexes."

This is a warning only — do not block deletion. The user may intentionally be removing a document and accepts that references to it will become dangling.

## Step 3 — Confirm deletion

Always confirm before deleting, regardless of how the skill was invoked. Even when called internally by the modify skill, confirm before proceeding unless the modify skill has already obtained confirmation from the user for the full modify operation.

Show the user exactly what will be deleted:

> "This will remove the following from the index:
>
> - Tree index: `.index/trees/financial_2023_apple-10k.json`
> - Master summary entry for: `financial/2023/apple-10k.md`
>
> The source file `financial/2023/apple-10k.md` will not be affected.
>
> Confirm? (yes / no)"

Wait for explicit confirmation. Do not proceed on ambiguous responses.

---

## Step 4 — Delete the tree index

Derive the tree index filename from the relative file path — replace directory separators (`/`) with underscores (`_`) and replace `.md` with `.json`.

**Example:** `financial/2023/apple-10k.md` → `.index/trees/financial_2023_apple-10k.json`

Check that the tree index file exists before attempting deletion. If it does not exist, note this but do not hard stop — the Document Summary Index leaf node may still need to be removed. Report:

> "⚠ Tree index file not found at `.index/trees/financial_2023_apple-10k.json` — it may have already been deleted. Proceeding to remove Document Summary Index leaf node."

Delete the tree index file. If deletion fails, hard stop and report the exact error.

---

## Step 5 — Call rebuild-summary in delete mode

Call the rebuild-summary skill in delete mode, passing the relative file path as the entry to remove.

If rebuild-summary reports that no leaf node was found in the Document Summary Index, note this in the final report but do not treat it as a failure — the tree index was already deleted.

If rebuild-summary fails for any other reason, hard stop and report:

> "Tree index was deleted but document-summary-index.json could not be updated. Run /docSearch:rebuild-summary directly to remove the leaf node for `<file>`."

---

## Step 6 — Report completion

```
Remove complete.

✓ Deleted tree index: .index/trees/financial_2023_apple-10k.json
✓ Removed Document Summary Index leaf node for: financial/2023/apple-10k.md

The source file has not been affected.
```

If there were any warnings (e.g. tree index was already missing):

```
Remove complete with warnings.

⚠ Tree index not found — may have already been deleted
✓ Removed Document Summary Index leaf node for: financial/2023/apple-10k.md

The source file has not been affected.
```

---

## Error handling

**Deletion of tree index fails:** hard stop immediately. Report the exact error and the state of what was and was not completed. Do not call rebuild-summary if the tree index deletion failed — the index state should remain unchanged.

**Called by modify skill:** when remove is called internally by the modify skill, the confirmation in Step 3 may be skipped if modify has already obtained explicit user confirmation for the full modify operation. The modify skill must pass a `confirmed` flag explicitly — do not skip confirmation based on assumption.
