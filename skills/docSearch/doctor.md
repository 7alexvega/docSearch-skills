---
name: doctor
description: Inspect and diagnose the health of the docSearch Index. Reports document counts, config summary, orphaned or dangling entries, unknown groupings, and null metadata; --deep additionally validates every tree index, confirms source files still exist, and flags stale ones; --quality adds summary quality metrics. Read-only — never repairs anything itself; every finding names the specific skill that fixes it. Use when the user runs /doctor, or says anything like "check the index", "is my index healthy", "what's in my index", "diagnose the index", "something seems wrong with the index", or "inspect .index".
needs: [global-rules, vocabulary, directory-structure, pipeline, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `pipeline`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Doctor Skill

You are reporting on the health of the index. This skill is strictly read-only: it never writes to `.index/` and never repairs anything. Every finding names the skill that fixes it.

Doctor does not implement its own checks. It runs the same validators that ingestion and publication run, so a rule cannot pass at write time and fail here, or vice versa. Your job is to run it and explain the result in a way a person can act on.

This is also the sanctioned way to inspect `.index/` directly — `global-rules` forbids hand-editing those files, and reading them through doctor is what closes that gap safely.

## Step 1 — Run it

```
node {{DOCSEARCH_SCRIPTS}}/doctor.js
```

Add `--deep` to parse every tree index, revalidate its structure and coverage, confirm every source file still exists, and check staleness fingerprints. Add `--quality` for summary quality metrics.

Deep and quality modes cost time proportional to vault size. Warn before running them on a vault beyond roughly 200 documents, and say what the wait buys.

If the user's request was vague ("check the index"), run the default first — it is cheap — and offer the deeper modes based on what it shows.

## Step 2 — Explain the result

The output carries `config_summary`, `stats`, and `findings`, each finding with a `severity`, a `message`, and the `fix` that addresses it.

Lead with the shape of the index, not the errors:

```
Index health — 270 documents, hierarchy doc_group → doc_type → product (depth 3)

  financial   112     technical   158
  schema_version 2 · chunking 150/200 lines

✓ Routing index structure valid
✓ No orphaned trees, no dangling entries

⚠ 3 documents have null metadata
    traefik3-docs/api.md — product          → /docSearch:modify
    …

⚠ 12 documents sit under an `unknown` grouping for `product`  → /docSearch:modify

Run /docSearch:doctor --deep to validate every tree and check for stale sources.
```

Group findings by severity, keep each to a line, and put the fix command on that line. A wall of individually-listed identical findings is less useful than a count plus two examples — summarize when a category exceeds about five entries and offer the full list.

Distinguish clearly between the three kinds of finding:

- **error** — the index is structurally wrong and something will misbehave. Name the fix and encourage running it.
- **warn** — the index works but retrieval quality is degraded, or it will break later. Explain the consequence, not just the condition.
- **info** — an observation, not a defect. `staleness_unknown` on pre-fingerprint documents is the common one; do not present it as a problem.

## Step 3 — On quality mode, interpret rather than dump

`--quality` reports `generic_rate`, `duplicate_sibling_summaries`, `root_summary_collisions`, `coverage_distribution`, and cross-reference resolution.

These are the numbers that predict whether retrieval works, so say what they mean:

- **generic_rate above zero** — those documents will route poorly, because the navigator picks branches by reading summaries. `/docSearch:modify` regenerates them.
- **coverage below 1.0 on any document** — parts of the source cannot be retrieved by any query at all. This is the most serious quality finding; treat it as an error in practice even though it is reported as a warning.
- **root summary collisions** — the routing layer cannot tell those documents apart.
- **low cross-reference resolution** — informational. Unresolved references are expected and by design; a very low rate may mean the source uses reference conventions the resolver does not recognize.

## Step 4 — Never repair

If the user asks doctor to fix what it found, do not. Run the skill that owns that mutation — `/docSearch:ingest`, `/docSearch:modify`, `/docSearch:remove`, `/docSearch:sync` — so the repair goes through the same validated, transactional path as any other change. Doctor writing to `.index/` would be a second, untested write path into the index, which is the thing this architecture exists to prevent.

---

## Error handling

**`doctor.js` exits 2** — it could not run. `no_config` means the vault was never onboarded; report the directory it searched.

**The routing index is missing while trees exist** — reported as `routing_index_missing`. This is serious and recoverable: `/docSearch:rebuild-summary` full rebuild reconstructs routing from the trees on disk.

**The routing index is unparseable** — never try to repair the JSON. Direct the user to a full rebuild.

**A vault directory that does not exist** — source-existence checks are skipped, but every other check still runs and still reports. Say which checks were skipped and why.
