---
name: onboarding
description: First-time setup for the docSearch Index system. Run this before any other skill. Configures the vault, document types, metadata schema, chunking rules, and query settings. Writes config.json and initializes the index directory structure. Trigger when the user runs /onboard or says anything like "set up the index", "initialize the vault index", "configure the index", or "first time setup".
needs: [global-rules, vocabulary, directory-structure, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. This file contains the global rules, vocabulary, directory structure, and all JSON schemas that this skill writes during setup. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Onboarding Skill

You are setting up the docSearch Index system for the first time. Your job is to guide the user through four rounds of configuration, write config.json, and initialize the index directory structure.

## Critical rules for this skill

- **Never advance to the next round until every question in the current round is unambiguously answered.** If a user gives a vague or incomplete answer, ask a follow-up question. Continue until the answer is clear. Do not make assumptions and proceed.
- **Show all defaults explicitly** whenever a configurable value is introduced. The user must consciously accept or change a default — never let a default apply silently.
- **Do not write any files until Round 4 confirmation.** All rounds are conversational. Nothing is written to disk until the user explicitly confirms the final config in Round 4.
- **Carry answers forward.** Reference earlier answers in later rounds where relevant. For example if the user confirmed page numbers in Round 1, surface the citation question in Round 2.5 without making the user repeat themselves.
- **One question at a time when clarifying.** If a user's answer is ambiguous, ask one focused follow-up. Do not pile multiple clarifying questions into a single message.

---

## Round 1 — Source and Document Type

Introduce yourself briefly:

> "Welcome to docSearch Index setup. I'll guide you through four short rounds of configuration. We won't write anything until you confirm everything looks right at the end. Let's start with your vault and document sources."

Then ask and resolve the following in order. Do not move to the next item until the current one is unambiguous.

### 1.1 — Ingestion directory

Ask for the absolute path to the vault ingestion directory. This is the root folder containing the markdown files to be indexed.

Validate that the path exists on disk. If it does not exist, tell the user and ask them to provide a valid path. Do not proceed until a valid path is confirmed.

### 1.2 — Doc types and path mappings

Ask what type(s) of documents are in the vault. Explain that a doc type describes the specific format of a document (e.g. `10-K`, `user_reviews`, `API_reference`, `research_paper`).

For each doc type the user names:

- Ask which subdirectory inside the ingestion directory contains files of that type
- Validate that the subdirectory exists on disk
- Ask which doc group it belongs to from this fixed list. Explain the purpose of doc groups: they cluster doc types for cross-type query filtering.

  Fixed doc group options:
  - `financial` — financial filings, reports, earnings
  - `legal` — contracts, agreements, regulatory
  - `technical` — documentation, APIs, architecture
  - `research` — academic papers, reports, analysis
  - `qualitative` — reviews, feedback, interviews, surveys
  - `operational` — internal processes, SOPs, policies
  - `general` — catch-all for anything that does not fit above

If the user names more than one doc type, ask whether the vault is **homogeneous** (all docs are the same type) or **mixed** (multiple doc types that may be queried together). Explain the difference:

- Homogeneous: simpler setup, single metadata schema
- Mixed: supports cross-type queries (e.g. comparing sentiment data against financial data), requires defining how doc types relate to each other

### 1.3 — Docling

Ask whether docling was used to convert PDFs to markdown before ingestion.

If yes:

- Do not ask whether page numbers are present — instead, read 20–30 lines from a sample file in the ingestion directory and check for page number patterns yourself (e.g. patterns like `<!-- Page 4 -->`, `---page 4---`, `Page 4`, or similar)
- If page numbers are detected, tell the user what pattern you found and confirm with them that this is correct
- If no page numbers are detected, tell the user and ask whether they believe the files should contain them. If the user believes they should, ask them to provide a sample line showing the format so you can recognize it
- If page numbers are confirmed present, note this — you will ask about citation preferences in Round 2.5

If docling was not used, ask directly: do the markdown files contain page number markers? If yes, ask for a sample line showing the format.

---

## Round 2 — Metadata Schema

Introduce this round:

> "Now let's define the metadata fields for each document type. These fields are stored in the Document Summary Index and determine how accurately queries are routed to the right documents. Every field should earn its place by either enabling routing decisions or appearing in citation output."

### 2.1 — Base schema

Explain that all documents regardless of type share these universal base fields. These are fixed and cannot be removed:

```
file, doc_type, doc_group, topics, date_added
```

Briefly explain each:

- `file` — filename, used for retrieval and citations
- `doc_type` — the document format, used for routing and schema selection
- `doc_group` — the category, used for cross-type filtering
- `topics` — key topics covered in the document, used for routing decisions
- `date_added` — when the document was indexed

### 2.2 — Doc type extension fields

For each doc type defined in Round 1, propose extension fields based on the doc type and doc group. Show your reasoning for each field — explain how it enables routing or citation. Use the examples below as a guide but adapt to the user's specific doc types.

**Example proposals by doc group:**

`financial`:

- `company` — critical for multi-company vaults and cross-filing queries
- `ticker` — optional, useful if querying by ticker symbol
- `fiscal_year` — critical for temporal queries like "highest revenue by year"
- `fiscal_quarter` — if filings are quarterly
- `period_end_date` — useful for precise temporal sorting
- `doc_subtype` — e.g. `annual`, `quarterly`, useful if mixing 10-K and 10-Q

`legal`:

- `parties` — who is named in the document
- `agreement_type` — e.g. `NDA`, `MSA`, `employment`
- `effective_date` — when the agreement takes effect
- `jurisdiction` — governing law

`technical`:

- `product` — which product or service this covers
- `version` — critical to avoid mixing v1 and v2 answers
- `doc_subtype` — e.g. `API reference`, `tutorial`, `architecture`
- `last_updated` — freshness signal

`research`:

- `authors` — for citation trails
- `publication_date`
- `domain` — field of study
- `methodology` — e.g. `quantitative`, `qualitative`, `systematic review`

`qualitative`:

- `source` — where the reviews or feedback came from
- `subject` — what product, service, or entity is being reviewed
- `period` — time period the data covers
- `sentiment_summary` — high level signal for routing

`operational`:

- `department` — which team this applies to
- `process_type` — e.g. `onboarding`, `incident response`
- `version` — document version
- `effective_date`

`general`:

- Propose fields based on what the user tells you about the content

For each proposed field, tell the user:

1. What the field is
2. Why it helps (routing or citation)
3. Whether it is recommended or optional

Ask the user to confirm, remove, or add fields. Do not proceed until the schema for every doc type is confirmed.

### 2.3 — Cross-type join fields (mixed vaults only)

Skip this section entirely for homogeneous vaults.

For mixed vaults, explain:

> "Cross-type join fields are fields that exist across multiple doc types but may have different names. They allow the query skill to connect data across doc types — for example, matching a 10-K entry for Apple with a user review entry for Apple using the `company` field. Without these, cross-type queries cannot reliably join related documents."

Look at the confirmed schemas for all doc types and identify candidate join fields — fields that represent the same concept across types. Propose them with their field name mapping.

Example:

> "I can see `company` appears in both your 10-K schema and your user_reviews schema under the same name. I also see `fiscal_year` in 10-K and `period` in user_reviews — these may represent the same concept. Should I treat these as join fields?"

For each proposed join field:

- Confirm the label (what to call this join concept)
- Confirm the field name in each doc type it spans
- Ask if the values will be consistent across doc types (e.g. both use "Apple" not "Apple Inc." in one and "AAPL" in another) — flag any inconsistency as a data quality risk

Do not proceed until all join fields are confirmed or the user explicitly says there are none.

---

## Round 2.4 — Document Summary Index Hierarchy

Introduce this section:

> "The Document Summary Index is the tree the query skill navigates first on every query to find relevant documents. Its structure is determined by which fields it groups documents by, and in what order. A well-designed hierarchy means the query skill can narrow down to the right documents in a few steps rather than scanning everything."

### 2.4.1 — Propose hierarchy fields

Based on the confirmed metadata schemas, propose a hierarchy field order.

**For a mixed vault:** the first two levels default to `doc_group` and `doc_type`, since those are the only fields guaranteed to differ across doc types. The user chooses what comes after.

**For a homogeneous vault:** `doc_group` and `doc_type` have exactly one value each — every document has the same one. Including them as hierarchy levels would add two fixed hops to every single query that never actually narrow anything down — pure overhead against the node budget for zero navigational benefit. Recommend skipping them as hierarchy levels entirely; the hierarchy starts directly at the first real differentiating extension field. `doc_group` and `doc_type` are still recorded on every leaf node as metadata (required by `base_schema` regardless of vault type) — they just aren't part of the tree's grouping structure. Explain this to the user:

> "Since your vault only has one doc type (`user_reviews`), grouping by doc_group and doc_type first would just be two single-branch hops before reaching anything that actually splits your documents up — they'd always have exactly one child, so descending into them never narrows the search. I'd skip straight to grouping by `<first extension field>` instead. If you're planning to add other doc types to this vault later, though, keeping doc_group/doc_type as explicit levels now avoids a hierarchy change (and full rebuild) down the line — your call."

This is a recommendation, not a forced default — per "Defaults are explicit," let the user consciously choose either shape.

For a mixed vault with fields `company`, `fiscal_year`:

> "I suggest organizing the Document Summary Index as: `doc_group → doc_type → company → fiscal_year`. This means the query skill first filters by group (financial), then type (10-K), then company (Apple), then year (2023). A query like 'Apple's Q1 2023 revenue' would navigate this hierarchy in 4 steps and reach only the relevant document — without reading any other entries.
>
> Does this hierarchy order make sense for how you will query your vault, or would you like to reorder the levels?"

Explain the reasoning: fields that narrow candidates most aggressively should come first. For financial vaults, `company` before `fiscal_year` makes sense because there are likely more companies than years. For a technical documentation vault with `product` and `version`, `product` before `version` makes sense for the same reason.

If the user wants a different order, apply it. If they are unsure, recommend the proposed default and explain they can change it later with `/docSearch:config-update` — though changing the hierarchy order requires a full rebuild of the Document Summary Index.

### 2.4.2 — Document Summary Index node budget

**Default: 15 nodes**

Explain:

> "This is the maximum number of Document Summary Index nodes the query skill can read when identifying candidate documents — before it even starts navigating per-document trees. This is separate from the per-document node budget.

> With a well-structured hierarchy of depth 4, navigating from root to a leaf takes 4 node reads. A budget of 15 allows the query skill to explore 3–4 branches before committing to candidates — enough for most queries including aggregation queries that need multiple documents.

> **15 is a reasonable default.** Raise it (e.g. to 25) if your vault is large and queries frequently need many candidate documents. Lower it (e.g. to 10) if your vault is small and well-organized.

> `--deep` doubles this budget for a single query alongside the per-document budget."

Ask the user to confirm or change this value.

---

## Round 2.5 — Output and Citation Preferences

Introduce this round:

> "A couple of preferences that affect how query results are returned to you."

### 2.5.1 — Output format

Ask the user's preferred output format for query results:

- **Structured JSON** (default) — the full answer and citation trail returned as a JSON object. Best if you want to process or pipe the output programmatically.
- **Prose with inline citations** — a readable answer with citations embedded inline, e.g. "Apple's Q1 revenue was $34.2B (apple-10k-2023.md > Revenue > Q1, lines 145–189, pp. 42–43)."

Explain that internally the query skill always retrieves in JSON — this setting only controls how the final answer is presented.

### 2.5.2 — Page numbers in citations (conditional)

Ask this only if page numbers were confirmed present in Round 1.

Ask whether page numbers should appear in citation trails. Explain the benefit:

> "If yes, every answer will include the page number(s) from the original source document. For example: apple-10k-2023.md > Revenue > Q1 Revenue (pp. 42–43). This lets you verify answers directly in the original PDF."

---

## Round 3 — Chunking and Query Limits

Introduce this round:

> "These settings control how documents are split during indexing and how deeply the query skill searches. I'll explain how each one affects your results so you can make informed choices. All of these can be changed later with /docSearch:config-update."

### 3.1 — Fallback chunk size

**Default: 150 lines**

Explain:

> "Some markdown files have no heading structure — for example, dense docling-converted PDFs where headers were not preserved. When a file has no headings, it cannot be split into a natural hierarchy. Instead it is split into fixed-size chunks of this many lines, each becoming a leaf node in a flat tree.

> A smaller value means more granular nodes and more precise retrieval, but a larger tree index and more nodes to navigate per query. A larger value means fewer nodes but coarser retrieval — the query skill may retrieve more content than needed to find the answer.

> **150 lines is a reasonable default for most documents.** Decrease it (e.g. to 100) if your files are very dense with information. Increase it (e.g. to 200) if your files are more narrative and context needs to be preserved across lines."

Ask the user to confirm or change this value.

### 3.2 — Max section size

**Default: 200 lines**

Explain:

> "Even in well-structured files with headings, a single section between two headers can be very long — for example a financial table that runs 600 lines. When a section exceeds this limit, it is automatically split into sub-chunks even without a sub-heading, each becoming a child node under the section heading.

> A smaller value means finer-grained navigation within long sections, at the cost of more nodes. A larger value preserves larger sections as single nodes, which is more efficient but may force the query skill to retrieve more content than needed.

> **200 lines is a reasonable default.** For financial documents with large tables, consider lowering to 150. For narrative documents where context matters, consider raising to 300."

Ask the user to confirm or change this value.

### 3.3 — Max depth per branch

**Default: 4**

Explain:

> "When the query skill navigates a tree index, this is the maximum number of levels it will descend into any single branch before stopping. A document with headings at #, ##, ###, and #### has 4 levels — so the default covers full depth for most documents.

> Lowering this (e.g. to 2 or 3) makes queries faster and cheaper because Claude reads fewer nodes, but risks missing answers buried in deeply nested sections. Raising it above 4 is only useful if your documents have very deep heading hierarchies.

> **If the query skill hits this limit without finding a sufficient answer, it will tell you — and you can rerun the query with the `--deep` flag, which doubles this limit for that single query.**"

Ask the user to confirm or change this value.

### 3.4 — Max nodes per query

**Default: 25**

Explain:

> "This is the total number of tree nodes the query skill can read across all trees in a single query, regardless of depth. It acts as a token budget cap — each node read costs tokens, and this prevents runaway queries from becoming expensive.

> For a single-document query, 25 nodes is generous. For a cross-document aggregation query across 10 files, 25 nodes means roughly 2–3 nodes per file, which forces the query skill to be selective. The query skill automatically detects aggregation queries and applies a higher budget — see the aggregation multiplier below.

> **If the query skill exhausts this budget before finding a complete answer, it will return what it found with a clear note that the search limit was reached. You can rerun with `--deep` to double this limit for that query.**"

Ask the user to confirm or change this value.

### 3.5 — Aggregation multiplier

**Default: 3**

Explain:

> "When the query skill detects an aggregation query — one that requires comparing or collecting data across multiple documents, such as 'which year had the highest Q1 revenue' — it automatically multiplies the max nodes per query by this value. This ensures aggregation queries have enough budget to reach leaf nodes in every relevant file without you needing to manually add `--deep` every time.

> With the default settings, an aggregation query gets 25 × 3 = 75 nodes. The query skill will notify you when it applies this multiplier.

> **You can still add `--deep` on top of an aggregation query if results are partial. `--deep` doubles the already-multiplied budget.**"

Ask the user to confirm or change this value.

---

## Round 3.6 — Ingestion Quality

Present these as a block with their defaults rather than asking about each one. They are the thresholds the ingestion pipeline classifies and validates against, and the defaults are right for most vaults.

> "Ingestion applies a quality floor. Structural correctness and complete source coverage are always enforced and cannot be turned off — a document whose content is not fully reachable is not something you can configure away. What you *can* tune is where the lines fall:
>
> **Source classification**
> - `placeholder_word_threshold` — **20**. A page with fewer prose words than this and no code is treated as a placeholder and excluded.
> - `redirect_max_prose_words` — **40**. A short page that points at another local document is recorded as an alias instead of being indexed separately.
> - `navigation_min_links` / `navigation_max_non_link_words` — **5 / 30**. A page with at least this many links and almost no text outside them is treated as navigation and excluded.
>
> **Summary quality**
> - Node summaries **15–60 words**, document summaries **30–100 words**.
> - `sibling_summary_similarity_max` — **0.85**. Sibling sections whose summaries are more alike than this are rejected and rewritten.
> - `root_summary_similarity_max` — **0.90**. Same rule across documents.
> - `semantic_retry_limit` — **2**. How many times a rejected summary is regenerated before the document is left out of the index.
>
> **Throughput**
> - `max_nodes_per_semantic_batch` — **12**, `max_content_characters_per_semantic_batch` — **30000**.
>
> Accept these defaults, or tell me which to change."

Two points worth making if the user asks why any of this exists:

- Excluded pages are not lost content. Redirects become aliases that queries still resolve; placeholders and navigation pages hold nothing a query could answer from. Indexing them makes routing worse, not better.
- A document that cannot earn a specific, distinguishable summary is left out rather than indexed badly. A vague summary does not merely fail to help — it actively misroutes queries away from documents that would have answered them.

If the vault is small or unusual (a handful of short reference cards, say), the placeholder threshold is the one most worth lowering. Everything else should stay at its default until there is evidence to move it.

---

## Round 4 — Review and Confirm

Construct the complete config.json from all confirmed answers, plus `"schema_version": 2` — this field is not asked about, it is always set to the current value the installed docSearch suite understands (see `global-rules` → "Schema version"). Include the full `ingestion_quality` block with its confirmed values, so every default is visible in the file rather than implied by its absence. Present the complete config to the user in full:

> "Here is the complete configuration I will write. Please review everything carefully. Once you confirm, I will write config.json and initialize your index directory. Nothing has been written to disk yet."

Show the full JSON.

Then ask:

> "Does everything look correct? Reply 'confirm' to proceed or tell me what to change."

Do not write anything until the user explicitly confirms.

---

## On Confirmation — Write and Initialize

Once the user confirms, perform these steps in order and report each one:

1. Determine the repository root — this is the current working directory where Claude Code is running. The `.index/` directory will always be created here, not inside the ingestion directory. Report: `✓ Index will be created at <repository_root>/.index/`

2. Create `.index/` at the repository root if it does not already exist. Report: `✓ Created .index/`

3. Create the `trees/` subdirectory inside `.index/`. Report: `✓ Created .index/trees/`

4. Write `config.json` to `.index/`. Report: `✓ Written .index/config.json`

5. Initialize an empty `document-summary-index.json` in `.index/` with this structure:

```json
{
  "type": "root",
  "summary": "Empty index — no documents ingested yet",
  "children": []
}
```

Report: `✓ Initialized .index/document-summary-index.json`

6. Verify the pipeline scripts are reachable and the vault is writable:

```
node {{DOCSEARCH_SCRIPTS}}/selftest.js
```

Report `✓ Pipeline verified` on success. If it fails, report the failing check verbatim and stop — every other skill depends on these scripts, so a broken install is far better caught here than midway through a first ingestion. A non-zero exit here almost always means the package was installed for a different runtime than the one now running, and reinstalling with `npx docsearch-skills@latest` fixes it.

7. Report completion:
   > "Setup complete. Your index is at `.index/` in the repository root.
   >
   > **Next step:** Run `/docSearch:ingest` to add documents to your index.
   >
   > **To change any setting later:** Run `/docSearch:config-update`. Note that schema changes will require running `/docSearch:schema-migrate` afterward to update existing index entries. Changing the Document Summary Index hierarchy order requires a full index rebuild."

---

## Error Handling

If any file system operation fails during the write phase, hard stop immediately and report:

- Exactly which operation failed
- The full error message
- What the user should check or do next

Do not partially initialize. If any step fails, tell the user which steps completed successfully before the failure so they know the state of the directory.
