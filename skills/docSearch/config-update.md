---
name: config-update
description: Change any configuration setting post-onboarding. Use when the user runs /config-update or says anything like "change the output format", "update the schema", "add a new doc type", "change the chunking settings", "update the node budget", "change vault type", "add a cross-type join field", "remove a metadata field", or "update the index configuration". Any post-onboarding configuration change goes through this skill.
needs: [global-rules, directory-structure, config-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. This file contains the global rules, directory structure, and config.json schema that this skill depends on. Required sections: `global-rules`, `directory-structure`, `config-schema`.

---

# Config-Update Skill

You are changing one or more settings in `config.json`. Every configuration change goes through this skill — the user never edits config.json manually.

Your job is to understand what the user wants to change, validate it, determine whether downstream consequences exist (schema changes that require migration, structural changes that require re-ingestion), warn the user clearly, and write the updated config only after explicit confirmation.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:
> "No index configuration found in `<cwd>`. Please run /docSearch:onboard first."

Read `document-summary-index.json` from `.index/` to understand the current index state — how many documents are indexed, what doc types exist, and what fields are currently populated. This context is needed to assess the impact of proposed changes.

---

## Step 1 — Understand the requested change

The user may ask for a change in plain language. Translate their request into the specific config field(s) that need updating. If the request is ambiguous, ask one clarifying question before proceeding.

**Examples of translations:**
- "Change output to prose" → `query.output_format: "prose"`
- "Add fiscal_quarter to 10-K" → add `fiscal_quarter` to `doc_types.schemas["10-K"]`
- "Increase the node budget" → `query.max_nodes_per_query: <new value>`
- "Make this a mixed vault" → `vault.type: "mixed"`
- "Add a new doc type" → new entry in `doc_types.schemas` and new path mapping in `vault.doc_type_path_mappings`
- "Remove the ticker field from 10-K" → remove `ticker` from `doc_types.schemas["10-K"]`
- "Change chunk size" → `chunking.fallback_chunk_size_lines: <new value>` and/or `chunking.max_section_size_lines: <new value>`
- "Add a cross-type join field" → new entry in `doc_types.cross_type_join_fields`

Show the user the specific change you are about to make before assessing consequences:
> "I'll update `query.output_format` from `json` to `prose`. Let me check if this has any downstream consequences."

---

## Step 2 — Assess downstream consequences

Every config change falls into one of three consequence tiers. Determine the tier before proceeding.

### Tier 1 — No downstream consequences
Changes that only affect future behavior. No existing index entries are affected.

- `query.output_format`
- `query.max_depth_per_branch`
- `query.max_nodes_per_query`
- `query.aggregation_multiplier`
- `chunking.fallback_chunk_size_lines`
- `chunking.max_section_size_lines`
- `source.page_numbers_in_citations` (output preference only — does not affect existing tree indexes)
- every field under `ingestion_quality`

For Tier 1 changes, confirm and write immediately. No migration needed.

> "This change only affects future behavior. Existing index entries are not affected."

Note: changing `chunking` settings does not retroactively change existing tree indexes — only future ingestions will use the new values. If the user wants existing files re-chunked, they need to run `/docSearch:modify` on those files after updating the config. Tell them this.

The same applies to `ingestion_quality`: thresholds are applied when a document is ingested, so raising or lowering one does not re-judge anything already in the index. `/docSearch:doctor --quality` reports which existing documents would fail the current thresholds, and `/docSearch:modify` brings a document up to them.

Two things about `ingestion_quality` are worth saying when a user asks to change it:

- **Nothing in it can disable structural or coverage validation.** Those are not thresholds; they are the guarantee that every line of a source is reachable by some query. If a user wants to bypass them, the honest answer is that there is no setting for it, and the underlying problem is worth diagnosing instead.
- **Loosening `sibling_summary_similarity_max` or lowering the word minimums trades retrieval accuracy for ingestion throughput.** That is sometimes the right call for a bulk import of near-identical documents. Say what is being traded so it is a decision rather than a default.

### Tier 2 — Schema migration required
Changes that affect the metadata fields in Document Summary Index leaf nodes. Existing leaf nodes become out of sync with the new schema.

- Adding a field to any doc type schema
- Removing a field from any doc type schema
- Adding a new doc type (no existing entries affected, but schema-migrate should be run to confirm alignment)
- Changing vault type from homogeneous to mixed (cross-type join fields need to be defined)
- Adding or modifying cross-type join fields

For Tier 2 changes, warn the user:
> "This change affects the Document Summary Index schema. After updating config, you will need to run `/docSearch:schema-migrate` to update existing leaf nodes.
>
> Until you run `/docSearch:schema-migrate`, queries may not route correctly for affected document types."

Offer to call `/docSearch:schema-migrate` automatically after writing the config, or let the user run it manually. Wait for their preference.

### Tier 3 — Re-ingestion required
Changes that affect the structure of tree indexes themselves. Existing tree indexes are no longer consistent with the new config.

- `source.docling_used`
- `source.page_numbers_present`
- Changing `vault.ingestion_directory`
- Changing `vault.doc_type_path_mappings` for a doc type that already has indexed files

For Tier 3 changes, warn the user strongly:
> "⚠ This change affects how documents are indexed at the tree level. Existing tree indexes were built with the previous setting and will not automatically update.
>
> To apply this change to existing documents, you will need to run `/docSearch:modify` on each affected file to re-ingest it with the new settings. Depending on how many files are affected, this could be time-consuming.
>
> Affected files: <list files from document-summary-index.json that would be affected>
>
> You can proceed with the config change now and re-ingest files gradually, or defer the change until you are ready to re-ingest. How would you like to proceed?"

Wait for explicit direction before writing.

### Tier 4 — Document Summary Index full rebuild required
Changes that affect the hierarchy structure of the Document Summary Index itself.

- Changing `doc_summary_index.hierarchy_fields` — reorders or adds grouping levels

For Tier 4 changes, warn the user strongly:
> "⚠ Changing the Document Summary Index hierarchy requires a complete rebuild of `document-summary-index.json`. The existing routing tree will be replaced. This does not affect per-document tree indexes or source files, but the rebuild reads all tree indexes and regenerates all intermediate node summaries.
>
> After this config change, run `/docSearch:rebuild-summary` and choose the full rebuild option.
>
> Confirm? (yes / no)"

Wait for explicit confirmation before writing.

---

## Step 3 — Handle special cases

### Adding a new doc type
When the user adds a new doc type, guide them through the full definition:

1. Doc type name
2. Doc group (from the fixed list: `financial`, `legal`, `technical`, `research`, `qualitative`, `operational`, `general`)
3. Path mapping — which subdirectory maps to this doc type
4. Extension schema fields — propose fields based on the doc group, explain each one's purpose, let the user confirm

Follow the same field-justification logic as onboarding Round 2: every field must earn its place by enabling routing or citation.

For mixed vaults, ask whether the new doc type should participate in any existing cross-type join fields, or whether new join fields are needed.

### Changing vault type from homogeneous to mixed
When the user changes vault type to mixed:

1. Confirm the doc types that will coexist
2. Ask what analytical relationship exists between them — what cross-type queries does the user want to run?
3. Identify candidate cross-type join fields from the existing schemas
4. Define the join field mappings (label → field name per doc type)
5. Include all of this in the config update
6. Check `doc_summary_index.hierarchy_fields`: a homogeneous vault onboarded per `onboarding.md`'s recommendation typically omits `doc_group`/`doc_type` from it entirely, since there was only one value of each. That no longer holds once multiple doc types coexist — without `doc_group`/`doc_type` as hierarchy levels, the Document Summary Index would group documents of different doc types together with nothing structurally separating them. If they're missing, recommend inserting `doc_group` and `doc_type` at the front of `hierarchy_fields`, matching the mixed-vault convention. This is a Tier 4 change (see above) — it requires the same full Document Summary Index rebuild as any other hierarchy change, and must be confirmed and warned about the same way.

Do not change vault type to mixed without at least one cross-type join field defined — a mixed vault with no join fields cannot perform cross-type queries meaningfully.

### Changing vault type from mixed to homogeneous
Warn the user:
> "Changing to homogeneous vault type will remove all cross-type join field definitions from config. Cross-type queries will no longer work. This does not affect individual doc type schemas or existing tree indexes.
>
> Confirm? (yes / no)"

Unlike the reverse direction, this is not a correctness issue — a homogeneous vault still works fine with `doc_group`/`doc_type` present as hierarchy levels, it's just two fixed hops that no longer narrow anything (see `onboarding.md` §2.4.1). Mention this as an optional follow-up, not something to push: they could drop `doc_group`/`doc_type` from `hierarchy_fields` for a small efficiency gain, but that's a Tier 4 change (full rebuild) on its own, and isn't worth the churn unless they're already touching the hierarchy for another reason.

### Removing a field from a doc type schema
Confirm data loss explicitly:
> "Removing `<field>` from the `<doc_type>` schema means this field will be deleted from all `<doc_type>` leaf nodes in the Document Summary Index when you run `/docSearch:schema-migrate`. This data cannot be recovered.
>
> Confirm? (yes / no)"

---

## Step 4 — Show proposed config change and confirm

Present the specific diff of what will change in config.json. Do not show the entire config — only the fields that are changing:

```
Proposed config change:

BEFORE:
  doc_types.schemas["10-K"]: ["company", "fiscal_year", "period_end_date"]

AFTER:
  doc_types.schemas["10-K"]: ["company", "fiscal_year", "period_end_date", "fiscal_quarter"]

Consequence: Tier 2 — schema migration required after this change.

Confirm? (yes / no)
```

Wait for explicit confirmation before writing.

---

## Step 5 — Write the updated config

Apply the change to the in-memory config object. Write the complete updated `config.json` to disk.

Report:
> "✓ config.json updated."

---

## Step 6 — Trigger downstream actions

**Tier 1:** nothing further needed. Report complete.

**Tier 2:** if the user asked for automatic schema migration, call `/docSearch:schema-migrate` now. Otherwise:
> "Config updated. Run `/docSearch:schema-migrate` when ready to update existing Document Summary Index leaf nodes."

**Tier 3:** remind the user which files need re-ingestion:
> "Config updated. The following files need to be re-ingested to reflect this change:
> <list affected files>
> Run `/docSearch:modify` on each file when ready."

---

## Error handling

**Write failure:** if writing config.json fails, hard stop and report the exact error. The config has not changed — tell the user the current config is still intact.

**Invalid value:** if the user requests a value that is invalid for that field (e.g. a negative node budget, an unrecognized doc group, a path that does not exist on disk), reject it immediately with a clear explanation and ask for a valid value. Do not write invalid config.

**Circular dependency:** if the user tries to add a cross-type join field that references a field not present in one of the doc type schemas, flag this before writing:
> "The join field `<label>` maps to `<field>` in `<doc_type>`, but `<field>` is not in the `<doc_type>` schema. Add it to the schema first, or choose a field that already exists."
