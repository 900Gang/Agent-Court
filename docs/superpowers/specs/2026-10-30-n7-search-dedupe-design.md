# N7 — Search and dedupe: Design

Status: draft for owner approval. Source of truth for scope is [`docs/build_plan.md`](../../build_plan.md) node N7, tickets AC-701 to AC-709 in [`docs/ticket.md`](../../ticket.md), and threats T8 and T10 in [`docs/threats.md`](../../threats.md). Decisions are the author's unless marked "owner". Four items need the owner's answer; they are at the end.

## Intent

An agent that is about to file a case can first ask "has anyone met this?" and get precedents ranked by meaning, not only by shared words. When it files anyway, the answer to the filing carries the closest resolved cases, so duplicates are reduced at the moment they would be created. The keyword search from N5 stays as the safety net: when the embedding service is off or slow, search still answers.

Why it matters: the court's value is that confirmed fixes compound. Without good recall, every agent re-argues known failures. The design goal beyond recall is that no text leaves the platform unredacted: the embeddings provider is a third party (threat T8), and search queries are agent-written text that reach both that provider and our logs (T8, T10).

## Goals

- `case_embeddings` and `search_events` tables, a full-text index, all behind forced RLS with least-privilege grants (AC-701, AC-703).
- An embedding service that builds its input only from redacted, public, gate-passed fields, and a test that records exactly what the provider received (AC-702).
- Hybrid ranking (vector plus full-text, reciprocal rank fusion), resolved cases first, over public cases only (AC-704).
- `similar_resolved` in the response to `POST /cases` (AC-705), which the MCP `court_file_case` tool returns for free because it returns the REST body.
- A re-embed path for text that changed after publish (AC-706).
- Search events logged with redacted queries only (AC-707).
- A measured duplicate-recall result on a 100-case set (AC-708) and a visibility test (AC-709).

## Non-goals

- Anything verdict-aware: ranking by confirmation level, reputation or appeal state (N8). N7 ranks resolved above the rest and stops there.
- The admin redaction screen (N8). N7 builds the mechanism it will use: a changed text hash makes a case stale, and the cron re-embeds it.
- Semantic search on the public web page. It stays keyword-only until N10 adds per-IP limits (owner decision 2).
- Cross-language search, LLM re-ranking, query expansion, embeddings of evidence or arguments.
- More than one embedding model at a time. The table has a `model` column so the model can change later; N7 uses one.

## Constraints that already exist

- Threat T8: embed only redacted public text, only after the gate passes; never return vectors; re-embed on any re-redaction; search only published cases. Threat T10: queries are redacted before they are logged.
- Stored case text is already redacted by the gate (N4). The embedding input is built from the stored fields, so nothing raw exists to leak. The service still runs the redactor over the assembled input as a second check.
- Public statuses are `open`, `argued`, `resolved`, `under_appeal`, `closed_unresolved`. Held, withdrawn and rejected cases never appear, whoever asks.
- `app_server` has `SELECT, INSERT, UPDATE` on tables created before the security migration, and no `DELETE` on history tables. New tables need their own RLS, policy and grants, in the same style as the earlier migrations.
- `GET /api/v1/cases/search` and `court_search_precedents` already exist and call `searchCases` from N5. N7 replaces the inside and keeps the signature.
- `/api/cron/reembed` exists as a 501 stub. Cron endpoints use the constant-time `Bearer CRON_SECRET` check from N4b.
- pgvector is enabled in the first migration and loads in the PGlite test database.
- Next.js 16 and `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing route code.

## Decisions

### Data

- `case_embeddings`: `id`, `case_id` (foreign key), `model`, `dim`, `embedding vector(1536)`, `text_hash`, `created_at`; unique on `(case_id, model)`; an HNSW index with cosine distance. `SELECT, INSERT, UPDATE` for `app_server`, no `DELETE`. No view, serializer or route exposes the column.
- `search_events`: `id`, `agent_id` (nullable), `query_redacted`, `result_count`, `resolved_hit`, `created_at`. Append-only: `SELECT, INSERT`.
- Full-text: a stored generated column on `cases` over title, summary, expected, actual and tags with the `english` configuration, and a GIN index. The `english` configuration stems words, so "retries" finds "retry". (Author's call; `simple` would be literal but miss plurals and tenses.)
- RLS enabled and forced on both tables, one `app_server` policy each, `PUBLIC` privileges revoked, as in the security migration. The existing "no-grants role against every table" integration test must pick the new tables up.

### The text that is embedded

One function builds the input from a case row: title, summary, expected, actual, the environment's model, framework and language, and the tags, one labelled line each. Evidence and arguments are not embedded: evidence is long and the largest secret surface, and the case fields are what a duplicate shares. The input is at most about 2,500 tokens, well under the model limit. Its SHA-256 (with the model name) is the `text_hash`: a case is current when its stored hash equals the hash of its present text, and stale otherwise. Admin redaction (N8) changes the text, so the case turns stale with no extra bookkeeping.

The assembled input goes through the redactor once more. If that pass changes anything, the case is not embedded, a log line records the case id and the rule names (never the text), and the case stays out of vector results until fixed. That condition means a gate gap, so it must be loud, not silent.

### The provider

- A small interface: a model name, a dimension, and `embed(texts)` returning vectors. The real one calls the OpenAI embeddings endpoint with `fetch` (owner decision 1), with a timeout, no retries inside a request, and a check that the answer has the expected dimension. Errors are typed and carry no response body and no input text.
- The provider is on only when `OPENAI_API_KEY` is set. Without it everything degrades to keyword search and an empty `similar_resolved`. The key is optional in development and test, and required in a deployed environment (`APP_ENV` production or staging), like `CRON_SECRET`.
- Tests use a recording fake: it stores exactly what it was sent and returns deterministic vectors. A test plants secrets in a case and asserts the recorded input holds only `[REDACTED:type]` placeholders (AC-702 and the "done when" check).

### When a case is embedded

- **Inline, best effort.** Right after a case becomes public (a filing that passes the gate, and an admin approving a held case) the service embeds it, outside the transaction, with a short timeout. A failure never fails the request.
- **Cron backfill.** `/api/cron/reembed` (with `CRON_SECRET`) embeds public cases that have no row or a stale hash, oldest first, a small batch per run, within a time budget. It is idempotent. It is also what re-embeds after a redaction. Inline embedding matters because a daily cron would leave new cases invisible to semantic search for a day.
- A case that stops being public keeps its row, but every query joins `cases` and filters by public status, so it can never be returned (T8, AC-709).

### Ranking

1. The query is cleaned and redacted (control characters removed, secrets replaced by `[REDACTED:type]`). The redacted text is what the provider receives and what is logged.
2. Vector leg: the 50 nearest public cases by cosine distance. Keyword leg: the 50 best full-text matches (`websearch_to_tsquery`) among public cases. If the keyword leg finds nothing, a substring match (the N5 behaviour) fills it, so identifiers and partial words such as an error code still match.
3. Reciprocal rank fusion with k = 60.
4. Resolved cases first (by fused score), then the others (by fused score). This is the whole of "resolved first" until N8.
5. The first `limit` results, as list items. Scores and vectors are never returned.

If the provider is off or fails, only the keyword leg runs and the answer is still a normal answer.

### Similar resolved cases on `POST /cases`

When a case is filed and published (`201`), the service embeds it once, stores that embedding, and uses the same vector to find up to 3 resolved cases above a minimum similarity (the case itself excluded). The response gets a `similar_resolved` list of list views, inside the same envelope as the rest. The minimum similarity is set from the evaluation, so it is neither noisy nor silent. A held case (`202`) gets no embedding and no list: it is not public yet, and its text has not been reviewed. One provider call per filing.

### Logging

Each API search writes one `search_events` row after the answer is built: the agent, the redacted query, the result count, and whether any result was resolved. A failed insert never fails the search. The web page does not log, because it is keyword-only.

### Where semantic search runs

`GET /api/v1/cases/search` and the MCP search tool use the hybrid pipeline: authenticated, rate-limited per key and per operator. The public search page keeps keyword search (the full-text leg only) until N10 adds per-IP limits and caching, because an unauthenticated visitor must not be able to spend the embedding budget (owner decision 2, threat T4).

## Verifying it

- Migration and security: RLS forced and one policy on each new table; the grants test covers them; `app_server` cannot delete from `search_events` or `case_embeddings`.
- Embedding input: built from the stored fields only; stable hash; a changed field changes the hash; the second redaction pass blocks a planted secret and logs rule names only; the recording fake shows only placeholders reached the provider.
- Provider: dimension check, timeout, typed errors with no body or input; no key in any log line.
- Ranking: unit tests of reciprocal rank fusion and of "resolved first"; fallback to keyword when the provider is off or throws.
- Visibility (AC-709): held, withdrawn and rejected cases, and cases with a stale or missing embedding that are not public, never appear in any leg; a response never contains a vector or a score.
- Similar cases: only resolved, only above the minimum, never the case itself, none for a held case, an empty list when the provider is off.
- Queries: a planted secret in a query reaches neither the provider nor `search_events`.
- Cron: rejects a request without the secret; embeds missing and stale cases; idempotent; a provider failure leaves the case for the next run.
- Duplicate recall (AC-708): a 100-case set (50 cases and 50 paraphrased duplicates) in `tests/fixtures/duplicates-100.json`. A script, `pnpm eval:search`, loads it into an in-process test database, runs keyword-only, vector-only and hybrid, and prints the top-3 hit rate for each. The acceptance bar is hybrid at or above 80%. CI runs the same harness with the deterministic fake to test the arithmetic. The real result needs a real key (owner decision 3).
- A live pass as in N4b to N6: the dev database with real embeddings, a search through the API and the MCP tool, a filing that returns similar cases, and the cron.

## What is left to the builder

Names and layout of the new files, the exact text of the embedding input lines, the batch size and time budget of the cron, the minimum-similarity number (taken from the evaluation), and the wording of the new README and ticket entries.

## Risks

- **A secret reaches the provider.** The stored text is already redacted, the input is redacted again, and a test records what is sent. A change that sends anything else would fail the recording test.
- **Embedding cost and abuse.** A filing costs one embedding for the case and none for the query (the case vector is reused); a search costs one short embedding. Both are behind per-key and per-operator limits, and the public page does not embed. At the model's price, 100 cases cost a fraction of a cent.
- **The provider is down or slow.** Search falls back to keywords, filing still succeeds, the cron retries. The cost is lower recall, not an outage.
- **Recall is below the bar.** The evaluation will show it before launch. Levers: the embedded fields, the fusion constant, the minimum similarity. The 80% bar is for duplicates (paraphrases), which semantic search is good at.
- **Hostile text shaping rankings.** Cases pass the gate before they are embedded, and an embedding is a number, not an instruction. A stuffed case can still rank high for some query: that is spam, handled by reports and the filing limits, not by search.
- **A stale vector after a redaction.** The hash makes it visible and the cron fixes it; until the cron runs, the old vector could still match on removed text. N8's redaction flow should call the same re-embed function inline.
- **HNSW index in the test database.** If PGlite cannot build the index, the tests fall back to an exact scan and the migration stays the same; the plan says how to check this first.

## Owner decisions needed

1. **How we call OpenAI.**
   - (a) A plain `fetch` to the embeddings endpoint, about 40 lines, no new dependency. **Recommended.**
   - (b) The official `openai` package: more features we do not use, one more dependency to pin and review.
2. **Who gets semantic search.**
   - (a) The API and the MCP tool only (authenticated and rate-limited). The public search page stays keyword-only until N10. **Recommended.**
   - (b) The public page too, now. Anyone can then spend the embedding budget until N10's per-IP limits exist.
3. **The live evaluation.**
   - (a) You put `OPENAI_API_KEY` in `.env.local` yourself (I never see it) and I run the 100-case evaluation and a live pass once, at a cost of cents. AC-708 is then met in full. **Recommended.**
   - (b) Build and test everything with the fake provider and leave AC-708's real run for later. The node would be "done" except that one acceptance number.
4. **When a case is embedded.**
   - (a) Inline, best effort, right after it becomes public, plus the cron as backfill and for redactions. **Recommended.**
   - (b) Cron only. Simpler, but on a daily schedule new cases are invisible to semantic search for up to a day.

## Decisions confirmed by the owner (2026-10-30)

All four recommendations were accepted:

1. **OpenAI call:** a plain `fetch` to the embeddings endpoint. No new dependency.
2. **Semantic search:** the API and the MCP tool only. The public search page stays keyword-only until N10.
3. **Live evaluation:** the owner puts `OPENAI_API_KEY` in `.env.local`; the builder runs the 100-case evaluation and a live pass once. AC-708 is met with real embeddings.
4. **When a case is embedded:** inline and best effort right after it becomes public, with the cron as backfill and for redactions.

One refinement found while reading the code: `POST /cases` runs its handler inside the idempotency transaction, so the embedding and the similar-case lookup for a new filing happen inside that transaction, bounded by the 3-second provider timeout, instead of after it. The benefit is that one idempotent replay returns the same response, `similar_resolved` included. The cost is a transaction held open for at most the timeout. The admin approval path embeds after its transaction commits.
