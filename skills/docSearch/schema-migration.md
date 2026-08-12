---
name: schema-migration
description: Updates Document Summary Index leaf nodes after config schema changes. Run after any /config-update that adds fields, removes fields, changes doc type schemas, changes vault type, or adds cross-type join fields. Use when the user runs /schema-migrate or says anything like "migrate the schema", "update the index after schema change", "sync the document summary index to the new schema", or "the schema changed and the index is out of date".
needs: [global-rules, vocabulary, directory-structure, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. This file contains the global rules, vocabulary, directory structure, and all JSON schemas that this skill reads and updates. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Schema-Migration Skill

You are updating `document-summary-index.json` to reflect schema changes made via `/docSearch:config-update`. Tree index files are never modified by this skill — only the Document Summary Index leaf nodes are affected.

Schema migration is a recovery and consistency operation. The goal is to bring every leaf node in the Document Summary Index into alignment with the current schema in config without losing data that was already correctly populated.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:
> "No index configuration found in `<cwd>`. Please run /docSearch:onboard first."

Read `document-summary-index.json` from `.index/`. If it does not exist, hard stop:
> "document-summary-index.json not found. Run /docSearch:onboard to initialize the index."

Load the current schema from config:
- `doc_types.base_schema`
- `doc_types.schemas` (all doc type extension schemas)
- `doc_types.cross_type_join_fields` (if vault is mixed)
- `vault.type`

---

## Step 1 — Identify affected leaf nodes

Traverse the Document Summary Index tree collecting all leaf nodes. For each leaf node, compare its fields against the current schema in config. Identify:

**Missing fields** — fields present in the current schema for that entry's `doc_type` but absent from the entry.

**Obsolete fields** — fields present in the entry but no longer in the current schema for that doc type. These are fields that were removed via `/docSearch:config-update`.

**Type changes** — fields present in both the entry and schema but where the expected value has changed in a way that makes the existing value suspect (e.g. `fiscal_year` was a string and is now expected to be an integer).

Build a complete picture before doing anything. Report what you found:

```
Schema migration analysis:

Schema changes detected:
+ fiscal_quarter added to 10-K schema
+ sentiment_score added to user_reviews schema
- legacy_id removed from 10-K schema

Affected leaf nodes:
  10-K (4 leaf nodes): missing fiscal_quarter, has obsolete legacy_id
  user_reviews (2 leaf nodes): missing sentiment_score
  
Unaffected leaf nodes:
  research_paper (3 leaf nodes): no changes needed
```

If no leaf nodes are affected, report and stop:
> "All Document Summary Index leaf nodes are already aligned with the current schema. No migration needed."

---

## Step 2 — Handle obsolete fields

For any field that has been removed from the schema, ask the user before removing data:

> "The following field has been removed from the schema and will be deleted from all affected leaf nodes:
> - `legacy_id` from 4 × 10-K leaf nodes
>
> This data cannot be recovered after migration. Confirm removal? (yes / no)"

Wait for explicit confirmation before removing any data.

If the user says no, note that the obsolete field will be left in place. It will not affect query behavior but will be present in the entry as an unrecognized field. Flag this in the final report.

---

## Step 3 — Auto-populate missing fields

For each affected entry with missing fields, infer the values by reading its corresponding tree index file. If more than one entry is affected, spawn one sub-agent per entry, all in parallel — this is read-only work, each sub-agent reads only its own tree index file and there's no shared state to coordinate, so it's safe to fan out the same way ingestion parallelizes per-file tree building. For a single affected entry, just do the inference directly. Either way, each entry's inference uses the same logic:

**How to infer values from tree indexes:**

Read the tree index JSON for the affected entry from `.index/trees/`. Look at:
- The `root_summary` — often contains entity names, dates, time periods, document type details
- Top-level child node headings and summaries — section titles often reveal fiscal periods, company names, versions, etc.
- The `file` path itself — directory names or filename patterns often encode the year, company, or version

For each field, apply judgment:
- `fiscal_year` — look for year patterns in root summary, filename, or section headings
- `company` — look for the entity name in root summary
- `fiscal_quarter` — look for Q1/Q2/Q3/Q4 patterns in root summary or headings
- `period_end_date` — look for specific dates in root summary or early sections
- `version` — look for version strings in filename or root summary
- `sentiment_summary` — look for sentiment signals in root summary

**Confidence threshold:** only populate a value if you are confident it is correct. If the evidence is ambiguous or absent, mark the field as `null` and flag it for manual review. Never guess to avoid a null.

Collect every entry's inferred values and nulls (from sub-agents if parallelized, or directly otherwise) into one review manifest before writing anything. This is presented to the user in Step 4.

---

## Step 4 — Present review manifest and get confirmation

Present the full review manifest to the user before writing anything. Format it clearly so the user can verify each inferred value:

```
Migration review manifest:

AUTO-POPULATED (inferred from tree indexes):
  financial/2023/apple-10k.md
    fiscal_quarter: "Q4" (inferred from root summary: "...annual filing for fiscal Q4 2023...")

  financial/2024/apple-10k.md  
    fiscal_quarter: "Q4" (inferred from filename pattern and root summary)

  financial/2023/microsoft-10k.md
    fiscal_quarter: "Q4" (inferred from root summary)

  financial/2024/microsoft-10k.md
    fiscal_quarter: "Q4" (inferred from root summary)

REQUIRES MANUAL INPUT (could not confidently infer):
  reviews/q1-2023.md
    sentiment_score: null — no sentiment signal found in tree index

OBSOLETE FIELDS TO REMOVE (confirmed in Step 2):
  legacy_id removed from all 4 × 10-K leaf nodes

Does everything look correct? You can:
- Confirm to proceed with migration as shown
- Correct any specific value before confirming
- Provide manual values for any null fields now or leave them null and update later with /docSearch:config-update
```

Wait for the user's response. If they correct a value, update the manifest and show the change before re-confirming. Do not proceed until the user explicitly confirms.

---

## Step 5 — Write the migrated leaf nodes

Apply all confirmed changes to the affected leaf nodes in `document-summary-index.json`:
- Add auto-populated and manually provided fields
- Set confirmed null fields to `null`
- Remove obsolete fields if confirmed in Step 2

Write the updated `document-summary-index.json` to disk.

---

## Step 6 — Report completion

```
Schema migration complete.

✓ 4 × 10-K leaf nodes updated
    fiscal_quarter populated for all 4
    legacy_id removed from all 4

✓ 2 × user_reviews leaf nodes updated
    sentiment_score: populated for 1, null for 1

3 × research_paper leaf nodes unchanged

⚠ 1 field requires follow-up:
  reviews/q1-2023.md → sentiment_score is null
  Run /docSearch:modify on this file to re-ingest and attempt re-population,
  or run /docSearch:config-update to provide the value directly.
```

---

## Error handling

**Tree index not found for an affected leaf node:** if a leaf node in the Document Summary Index has no corresponding tree index file, report it and skip auto-population for that leaf node:
> "⚠ Tree index not found for `<file>` — cannot auto-populate missing fields. Leaf node will have null values for new fields. Consider running /docSearch:ingest to rebuild the tree index."

Do not remove the leaf node — it may still be valid and removing it would require re-ingestion.

**Write failure:** if writing `document-summary-index.json` fails, hard stop and report the exact error. Tell the user which changes were applied in memory so they can recover. Do not partially write.

**Migration called when no schema change has occurred:** if all leaf nodes are already fully aligned with the current schema, report this clearly and stop. Do not modify anything unnecessarily.
