---
name: query
description: Query the docSearch Index to retrieve accurate answers with full citation trails. Use when the user runs /query or asks any question about the content of their indexed documents — anything like "what does the index say about X", "find information about Y", "which document covers Z", "compare X across filings", "what was the revenue in Q1", "summarize the risk factors", or any question that should be answered from indexed content rather than general knowledge. Always use this skill when the user is asking about their vault content.
needs: [global-rules, vocabulary, directory-structure, config-schema, document-summary-index-schema, tree-index-schema]
---

## Step 0 — Load shared context

Read `{{DOCSEARCH_CONTEXT}}` in full before proceeding. This file contains the global rules, vocabulary, directory structure, and all JSON schemas that this skill navigates. Required sections: `global-rules`, `vocabulary`, `directory-structure`, `config-schema`, `document-summary-index-schema`, `tree-index-schema`.

---

# Query Skill

You are answering a question using the docSearch Index. You navigate the index hierarchically — reading the minimum content necessary to produce an accurate answer with a full citation trail. You never read source files in full. You never answer from general knowledge when the answer should come from the index.

Accuracy is the highest priority. An incomplete answer that is honest about its limits is always better than a complete-seeming answer that is wrong or unverifiable.

## Before anything else

Read `config.json` from `.index/`. If it does not exist, hard stop:

> "No index configuration found in `<cwd>`. Please run /docSearch:onboard first."

Read `document-summary-index.json` from `.index/`. If it does not exist, hard stop:

> "document-summary-index.json not found. Run /docSearch:onboard to initialize the index."

Read `.index/aliases.json` if it exists. It maps redirect source paths to their canonical documents. It is often absent — that is normal for a vault with no redirect pages — and its absence is never an error.

Load from config and hold in context:

- `doc_summary_index.max_nodes`
- `query.max_depth_per_branch`
- `query.max_nodes_per_query`
- `query.aggregation_multiplier`
- `query.output_format`
- `source.page_numbers_in_citations`
- `vault.ingestion_directory`
- `doc_types.cross_type_join_fields` (if vault is mixed)

Check for the `--deep` flag in the user's query. If present, double `doc_summary_index.max_nodes`, `max_depth_per_branch`, and `max_nodes_per_query` for this query only. Note this in the query output.

Check for the `--verify` flag. If present, citation verification (Step 7.2) always runs for this query, regardless of the confidence it ends up with.

---

## Step 1 — Classify the query

Before touching any index, classify the query into one of four types. This classification determines the node budget, fan-out behavior, and output structure.

### Single-document lookup

The query seeks specific information that likely exists in one document.

- "What are Apple's Q1 2023 revenue figures?"
- "What does the Risk Factors section say about interest rate exposure?"
- "What methodology is used in Note 8?"

Node budget: `max_nodes_per_query` (standard)

### Cross-document aggregation

The query requires collecting and comparing data across multiple documents of the same or related doc types.

- "Which year had the highest Q1 revenue?"
- "How have operating expenses trended across all filings?"
- "Compare the risk factors across all 10-K filings."

Node budget: `max_nodes_per_query × aggregation_multiplier`. Notify the user:

> "This is an aggregation query — applying 3× node budget (75 nodes)."

### Cross-type analytical

The query requires reasoning across documents of different doc types, joining on cross-type join fields.

- "Does customer sentiment correlate with revenue growth?"
- "In periods where reviews were negative, what did the financials show?"

Node budget: `max_nodes_per_query × aggregation_multiplier`. Apply the cross-type disclaimer to the final answer (defined in Step 6).

### Ambiguous

The query scope is unclear.

- "Tell me about Apple." (which documents? which aspects?)
- "What happened in Q1?" (which year? which metric?)

Do not guess. Ask one clarifying question:

> "Could you be more specific? For example: are you asking about Apple's financials, a specific year, or a particular topic?"

Continue asking until the query is unambiguous. Then re-classify.

---

## Step 2 — Navigate the Document Summary Index

Load `document-summary-index.json`. Navigate top-down using a separate node counter capped at `doc_summary_index.max_nodes`. This budget is independent of the per-document tree budget — exhausting it does not reduce the budget available for per-document navigation.

### Navigation rules

**At each node read the summary only.** Use the summary to decide whether to descend.

**Decision at each node:**

- Does this node's summary suggest its subtree contains documents relevant to the query?
  - Yes → descend into children
  - No → do not descend. This entire subtree is excluded.
  - Uncertain → for intermediate nodes, descend only if the query could plausibly match. When in doubt at aggregation queries, err toward inclusion.

**At the root:** always read it. Its summary describes the entire index.

**At intermediate nodes:** read the summary and decide per branch. This is generic over whatever `hierarchy_fields` actually is for this vault — for a mixed vault, a query about Apple's financials should descend into `doc_group: financial` and `company: Apple` but not into `doc_group: qualitative` or `company: Microsoft`; a homogeneous vault has no `doc_group`/`doc_type` levels to speak of (see `onboarding.md` §2.4.1) and the same decision rule applies starting from whatever its first configured field is.

**At leaf nodes:** these are candidate documents. Add them to the candidate list. Do not read their `tree_index` yet — that happens in Step 3.

### For single-document lookup

Navigate narrowly. Follow the most specific path through the hierarchy. Stop as soon as you have 1–2 strong candidates.

### For cross-document aggregation

Navigate all branches that could contain relevant documents. For a query like "which year had highest Q1 revenue", descend into every `fiscal_year` node under the relevant `company` and `doc_type` — collect all leaf nodes in that subtree.

### For cross-type analytical queries

Navigate branches across multiple doc groups. Use `cross_type_join_fields` from config to identify which doc types should be analyzed together. Collect leaf nodes from all relevant doc types.

### Budget exhaustion at this stage

If `doc_summary_index.max_nodes` is exhausted before the tree is fully explored, stop navigation and proceed with the candidates collected so far. Note in the output:

> "⚠ Document Summary Index navigation budget exhausted ({n} nodes). Some document branches may not have been explored. Re-run with --deep for broader coverage."

### Resolving a path the user named directly

When the user's query names a specific file path and no routing leaf matches it, check `.index/aliases.json` before concluding nothing was found. A redirect page is not indexed as its own document — it resolves to a canonical one. If the path is an alias, navigate to the target document and note the resolution in the answer:

> "`legacy/old-config.md` is a redirect to `guides/configuration.md`; answering from the latter."

This costs no tree-navigation budget and turns a dead end into an answer.

### Result

A ranked list of candidate documents (leaf nodes) with their metadata and `tree_index` filenames. If no candidates are found, hard stop:

> "No indexed documents appear to contain information relevant to this query. The following branches were searched: <summary of nodes visited>."

Do not fabricate an answer if no candidates are found.

---

## Step 3 — Navigate tree indexes

For each candidate document, navigate its tree index **lazily** — read one node at a time using the peek command defined in `context.md`'s `tree-index-schema`, never the whole file at once. A large document's tree can have hundreds of nodes; the point of navigation is to act on a handful of them, so only those handful should ever enter context. Loading the whole tree up front would mean paying for every node whether or not navigation ever looks at it.

Maintain a running node counter across all trees. Hard stop navigation — not the query — when the node budget is exhausted (see budget exhaustion handling below).

### The peek protocol

**Root peek, once per tree:** call the peek command with address `[]`. This returns `file`, `doc_type`, `root_summary`, `source_fingerprint`, and a shallow view of the top-level children (heading, level, summary, `node_id`, `cross_refs`, `is_leaf` — not their own children).

**Quality-policy check:** if the tree's root has no `schema_version`, or a value below the current one, it was built by an older pipeline. Its structure was never verified against the coverage rules in force today, so parts of the document may be unreachable. Do not refuse to use it — note it in the answer's warnings and suggest `/docSearch:modify` to bring it up to date. `/docSearch:doctor --quality` reports how many such documents exist.

**Staleness check, right after the root peek:** if `source_fingerprint` is present, recompute the source file's current fingerprint with the same command and compare. If they differ, the file changed since ingestion and every `content_ref` line range in this tree may now point at the wrong content — do not hard stop, the file still exists and may still be useful, but mark this document `stale` for the rest of this query: every citation from it carries a `⚠ STALE` marker (Step 6), and any answer relying on it cannot receive `confidence: high` (Step 7.1). If `source_fingerprint` is absent, staleness cannot be determined — proceed normally, without a marker. This is the expected state for any document indexed before `schema_version: 1`, not an error.

**Each further peek, one index level at a time:** from a shallow children view, decide which child (if any) to descend into, then peek that child's own index path (e.g. root's `children[2]` → address `[2]`; its own `children[0]` → address `[2,0]`) to get *its* fields plus *its* children's shallow view. Repeat until you reach a leaf.

**Decision at each peek:**

- Does this node's summary suggest it contains the answer or part of the answer?
  - Yes → peek into its children (non-leaf) or retrieve content (leaf)
  - No → do not descend. Mark this branch as not relevant and move on — its subtree is never peeked, so it never enters context.
  - Uncertain → check whether the node has `cross_refs` hinting at relevant content. If yes, tentatively descend. If still uncertain, do not descend — uncertainty is not a reason to consume node budget.

**Depth limit:** do not descend beyond `max_depth_per_branch` levels in any single branch. If the depth limit is reached without finding a leaf, the content at that depth is the deepest retrievable point — retrieve it if the summary is relevant.

**Node budget accounting:** one peek call = one node charged against the budget (the node you're examining and deciding on). The children shown in that same call's shallow view aren't charged until a later peek actually descends into one of them.

**Cross-reference handling at nodes:**
When a peeked node's `cross_refs` (visible in its own fields, or in a child's shallow view) is relevant to the query:

- If `type` is `intra` and `resolved_node` is not null: peek using `resolved_node` (the target's `node_id`) as the address instead of an index path — this jumps straight to the target node regardless of where it sits in the tree. It counts against the node budget, same as any other peek.
- If `resolved_node` is null: note the unresolved reference in the answer — the user may need to follow it manually.
- If `type` is `inter` and `resolved_file` is not null: add the referenced document to the candidate list if not already there. Navigate it the same lazy way, starting from its own root peek.
- If `type` is `inter` and `resolved_file` is null: note the dangling reference — the referenced document is not indexed.
- If not relevant: ignore the cross-reference.

### Leaf node retrieval

The source file path is: `vault.ingestion_directory` + `/` + the `file` value from the tree index root (available from the root peek).

If the source file cannot be found at that path, hard stop:

> "Source file `<path>` not found. The file may have been moved or deleted. Run /docSearch:modify to re-index it, or /docSearch:remove to clean up the index entry."

Once a peek shows `is_leaf: true` and you've decided to retrieve it, read the line range from `content_ref` in the source markdown file — the same file's already-known staleness marker (set once, right after the root peek) applies to this citation. Read only those lines — not the full file.

### For aggregation queries

Navigate all candidate trees in parallel where possible. Collect the relevant leaf content from each before synthesizing. Do not synthesize after finding the first relevant result — collect from all candidates first.

### For cross-type analytical queries

Navigate trees for each doc type separately. Collect findings per doc type. Hold all findings in context before synthesizing in Step 5.

---

## Step 4 — Sufficiency check

After retrieving content from one or more leaf nodes, assess: does the retrieved content fully answer the query?

**Sufficient:** the content directly answers the question with enough detail that the user does not need to look further. Proceed to Step 5.

**Partially sufficient:** the content answers part of the question but is missing something specific. Before retrieving more, ask: is the missing part likely to be in an unvisited branch of the current tree, or in a different candidate document? If yes and budget remains, continue navigation. If the budget is running low, proceed to synthesis with a clear note about what is missing.

**Insufficient:** the retrieved content does not answer the question. Check whether other candidate documents remain. If yes and budget remains, continue. If no candidates remain or budget is exhausted, proceed to Step 5 with a not-found result.

**Budget exhaustion:** if the node budget is exhausted before sufficiency is reached, stop navigation and synthesize from whatever was retrieved. Always include in the output:

> "⚠ Node budget exhausted ({n} nodes read). This answer may be incomplete. Re-run with --deep for a more thorough search."

---

## Step 5 — Synthesize the answer

Synthesize from the retrieved leaf content only. Do not blend in general knowledge. If the index content is ambiguous or incomplete, say so — do not fill gaps with assumptions.

**For single-document lookup:** synthesize directly from the retrieved content. One answer, one source path.

**For cross-document aggregation:** synthesize across all retrieved content. Identify the pattern, trend, or comparison the user asked for. Be explicit about which documents contributed to the answer.

**For cross-type analytical queries:** synthesize in three layers —

Layer 1 — Synthesized conclusion:
Reason across the retrieved data from all doc types and state a conclusion. Be specific about what the data shows. Do not overstate confidence — if the data suggests a pattern but does not prove it, say so.

Layer 2 — Raw findings per doc type:
Present the retrieved data from each doc type separately so the user can verify the inputs to the synthesis.

Layer 3 — Disclaimer (hardcoded, always present on cross-type synthesis):

> "This synthesis reasons across document types with different structures and purposes. The conclusion above reflects patterns in the retrieved index data. Independent verification is recommended before acting on cross-type analytical conclusions."

---

## Step 6 — Construct the citation trail

Every answer must include a citation trail. The citation trail is the verification mechanism — the user should be able to follow it to the exact source content.

For each piece of retrieved content, construct a citation:

**Without page numbers:**

```
financial/2023/apple-10k.md
  → Revenue > Q1 Revenue
  → lines 145–189
```

**With page numbers:**

```
financial/2023/apple-10k.md
  → Revenue > Q1 Revenue
  → lines 145–189 (pp. 42–43)
```

**With cross-reference followed:**

```
financial/2023/apple-10k.md
  → Revenue > Q1 Revenue (lines 145–189, pp. 42–43)
  → [cross-ref] Notes > Note 8 — Revenue Methodology (lines 312–334, pp. 61–62)
```

**With unresolved cross-reference:**

```
financial/2023/apple-10k.md
  → Revenue > Q1 Revenue (lines 145–189, pp. 42–43)
  → [unresolved cross-ref] "see prior year filing" — referenced document not indexed
```

**With dangling cross-reference:**

```
financial/2023/apple-10k.md
  → Revenue > Q1 Revenue (lines 145–189, pp. 42–43)
  → [dangling cross-ref] "see apple-10k-2022.md" — referenced document has been removed from index
```

**From a stale document** (source file fingerprint no longer matches — see Step 3):

```
financial/2023/apple-10k.md ⚠ STALE — source file has changed since this was indexed
  → Revenue > Q1 Revenue
  → lines 145–189 (may no longer be accurate — run /docSearch:modify to re-index)
```

For aggregation queries, list citations for every document that contributed to the answer.

---

## Step 7 — Determine confidence, verify, and return

### 7.1 — Determine confidence

Set `confidence`:

- `high` — the retrieved content directly and unambiguously answers the query
- `partial` — the content partially answers the query or the budget was exhausted before full coverage
- `low` — the content is indirect, ambiguous, or the answer required significant inference

**Then apply the staleness ceiling:** if any citation the answer relies on came from a document marked `stale` in Step 3, cap `confidence` at `partial` regardless of what the rule above would otherwise set — content directness cannot compensate for line numbers that may no longer point at the right text. Add a warning naming which file was stale.

### 7.2 — Verify citation faithfulness (conditional)

This checks one specific thing: **does the cited text actually support the claim it's attached to** — not whether this was the best document, the best citation, or a good answer overall. Skip this step entirely unless one of these is true, since it roughly doubles the cost of the query:

- the user's query included `--verify`, or
- `confidence` from 7.1 is `partial` or `low`, or
- this is a cross-type analytical query (which already carries the Step 5 disclaimer for the same underlying reason)

When triggered, spawn a sub-agent with exactly:
- the synthesized answer text (Step 5)
- the full citation trail (Step 6) — file, section path, line range, page range
- read-only file access, scoped to the cited source files only

**Do not give the sub-agent the navigation trace, node summaries, or tree indexes.** It must not see how the answer was produced — only the finished answer and its citations — or it will anchor to the same reasoning that may have produced a bad citation in the first place, defeating the point of a second opinion.

Give the sub-agent this task: for each citation, read the cited line range from the named source file plus roughly 10 lines of surrounding context on each side, and decide whether that text supports the specific claim the citation is attached to. It reports exactly one of `SUPPORTED`, `PARTIALLY SUPPORTED`, or `NOT SUPPORTED` per citation, with a one-sentence reason.

Apply the result:
- **All `SUPPORTED`** — no change to `confidence`. Set `citation_verification: "passed"`.
- **Any `PARTIALLY SUPPORTED` or `NOT SUPPORTED`** — cap `confidence` at `low` regardless of what 7.1 set, and add a warning naming the specific citation and reason:
  > "⚠ Citation verification: `financial/2023/apple-10k.md` → Revenue > Q1 Revenue does not clearly support the claim '<claim>' — <reason>."

  Set `citation_verification: "failed — see warnings"`.

  **One optional retry:** if this query was not already running with `--deep` and at least one citation was `NOT SUPPORTED`, you may re-run the query once with `--deep` applied internally (do not ask the user first), then run 7.2 once against the new answer. Never retry more than once regardless of outcome — report the second result as-is, whether it passes or not.

If this step did not run at all (none of the trigger conditions applied), set `citation_verification: "not run"`.

### 7.3 — Format and return the answer

Format according to `query.output_format` from config.

**Structured JSON (default):**

```json
{
  "query": "Which year had the highest Q1 revenue?",
  "classification": "cross-document aggregation",
  "answer": "2023 had the highest Q1 revenue at $34.2B, compared to $29.1B in 2022 and $31.8B in 2024.",
  "confidence": "high | partial | low",
  "citation_verification": "not run | passed | failed — see warnings",
  "dsi_nodes_read": 8,
  "dsi_budget_used": "8 / 15",
  "tree_nodes_read": 18,
  "tree_budget_used": "18 / 75 (aggregation budget)",
  "deep_mode": false,
  "citations": [
    {
      "file": "financial/2023/apple-10k.md",
      "path": ["Revenue", "Q1 Revenue"],
      "lines": [145, 189],
      "pages": [42, 43],
      "cross_refs_followed": [],
      "stale": false
    }
  ],
  "warnings": [],
  "disclaimer": null
}
```

Set `disclaimer` to the cross-type disclaimer text only for cross-type analytical queries. Null otherwise.

### Prose with inline citations

Write a natural language answer with citations embedded inline. Example:

> Apple's Q1 2023 revenue was $34.2B, the highest across all indexed filings (`financial/2023/apple-10k.md` → Revenue > Q1 Revenue, lines 145–189, pp. 42–43). This compares to $29.1B in Q1 2022 (`financial/2022/apple-10k.md` → Revenue > Q1 Revenue, lines 138–181, pp. 39–40) and $31.8B in Q1 2024 (`financial/2024/apple-10k.md` → Revenue > Q1 Revenue, lines 152–196, pp. 44–45).
>
> _Node budget: 18 / 75 used._

Include budget usage and any warnings at the end. If citation verification ran, note its outcome (`citation_verification` from Step 7.2) alongside the warnings — silently passing is fine to omit, but a failed verification must appear here, not just in the JSON form. For cross-type analytical queries, append the disclaimer as a separate paragraph.

---

## Error handling

**No relevant documents found in Document Summary Index:** hard stop with a clear statement of what was searched. Never generate an answer from general knowledge.

**Source file missing at retrieval time:** hard stop with path and recovery instructions (/docSearch:modify or /docSearch:remove).

**Tree index JSON missing for a candidate document:** report the inconsistency and skip that document:

> "⚠ Tree index not found for `<file>` despite being listed in document-summary-index.json. Skipping this document. Run /docSearch:rebuild-summary to check index consistency."

Continue with remaining candidates rather than aborting the entire query.

**Budget exhausted:** return partial answer with explicit warning. Never silently truncate.

**Cross-type query on homogeneous vault:** if the query appears to require cross-type analysis but the vault is homogeneous, tell the user:

> "This query appears to ask for cross-type analysis, but your vault is configured as homogeneous (single doc type). If you have added documents of different types, run /docSearch:config-update to configure a mixed vault."
