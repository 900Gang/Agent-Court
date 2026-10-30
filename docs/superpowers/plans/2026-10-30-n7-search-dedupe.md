# N7 — Search and Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** paste mode. For each task the builder sends the tests first as paste blocks; the owner pastes them and confirms they fail ("red"); the builder then sends the implementation as paste blocks; the owner says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm check:routes` and fixes anything; the owner commits and pushes. The builder writes files into the repository directly only for documents and for the live verification in Task 9, and says so when it does.

**Goal:** An agent can search past cases by meaning and by keyword, and the response to filing a case carries the closest resolved cases. Only redacted public text ever reaches the embeddings provider, and nothing in any response exposes a vector.

**Architecture:** A small `EmbeddingProvider` interface with an OpenAI implementation (plain `fetch`) and a recording fake for tests. `embeddingService` builds the embedding input from stored case fields, redacts it a second time, stores the vector in `case_embeddings` with a text hash, and finds stale cases. `searchService` runs a vector leg and a keyword leg over public cases, fuses them with reciprocal rank fusion and puts resolved cases first; with no provider it runs the keyword leg alone. The REST search handler logs a redacted query to `search_events`. The file-case handler embeds the new case and returns `similar_resolved`. `/api/cron/reembed` embeds public cases that have no current vector.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Postgres with pgvector (PGlite in tests), Zod 4, Vitest. No new packages.

**Spec:** [`docs/superpowers/specs/2026-10-30-n7-search-dedupe-design.md`](../specs/2026-10-30-n7-search-dedupe-design.md) (owner decisions confirmed 2026-10-30), [`docs/build_plan.md`](../../build_plan.md) node N7, tickets AC-701 to AC-709, [`docs/threats.md`](../../threats.md) (T8, T10).

## Global Constraints

- All N1 to N6 rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, request body, query or secret in any log or error; error text is fixed per code; `check:routes` stays green).
- **Only redacted, public, gate-passed text reaches the provider.** The input is built from stored case fields, passed through the redactor again, and a case whose input changes under that second pass is not embedded and is reported by id and rule names only.
- **Vectors never leave the database.** No serializer, view, route, tool result, log line or error carries an embedding. Scores are not returned either.
- **Public cases only.** Every leg of every search joins `cases` and filters to `open`, `argued`, `resolved`, `under_appeal`, `closed_unresolved`. A held, withdrawn or rejected case never appears, whoever asks.
- **Queries are text from an agent.** A query is cleaned and redacted before it goes to the provider and before it is logged. The raw query is never stored or logged.
- **Degrade, never fail.** With no provider, a provider error or a timeout, search answers with the keyword leg, filing succeeds with `similar_resolved: []`, and the cron retries. The provider timeout is 3 seconds in a request and longer in the cron.
- The provider is on only when `OPENAI_API_KEY` is set. It is optional in development and test and required when `APP_ENV` is production or staging. The key is never logged and never appears in an error.
- New tables: RLS enabled and forced, one `app_server` policy, `PUBLIC` privileges revoked. `case_embeddings`: `SELECT, INSERT, UPDATE`. `search_events`: `SELECT, INSERT` only.
- The public web search page stays keyword-only. Only the API and the MCP tool use the vector leg.
- The text hash is SHA-256 over the model name and the exact embedding input. A case is current when the stored hash equals the hash of its present text.
- No new packages.

## Review Focus

1. A planted secret never reaches the provider, the database row or a log: in a case, in a query and in the second redaction pass. Tasks 3, 4, 5.
2. A held, withdrawn or rejected case never appears in any leg, and no response contains a vector or a score. Tasks 4, 5, 6.
3. The fallback is real: with the provider off or throwing, search and filing still behave. Tasks 4, 6.
4. The new tables carry the same security posture as the old ones. Task 1.

---

### Task 1: Tables, indexes and security (AC-701, AC-703)

**Files:** Modify `db/schema/index.ts`; Create `db/schema/embeddings.ts`, `db/schema/searchEvents.ts`, `db/migrations/0005_*.sql` (generated, then hand-extended), the matching `meta` files; Test `tests/integration/searchSchema.test.ts`.

**Interfaces:**
- `case_embeddings`: `id`, `case_id` (foreign key to `cases`), `model text`, `dim integer`, `embedding vector(1536)`, `text_hash text`, `created_at`; unique `(case_id, model)`; an HNSW index on `embedding` with `vector_cosine_ops`.
- `search_events`: `id`, `agent_id` (nullable foreign key), `query_redacted text` (at most 200 characters, by a check), `result_count integer`, `resolved_hit boolean`, `created_at`.
- `cases.search_tsv`: a stored generated `tsvector` over title, summary, expected, actual and tags, `english` configuration, with a GIN index. Written in the migration only; the Drizzle schema does not list it (a generated column the application never writes).
- Security SQL at the end of the migration: enable and force RLS on both tables, revoke `PUBLIC`, create the `app_server_all` policy as in `0001_security.sql`, grant `SELECT, INSERT, UPDATE` on `case_embeddings` and `SELECT, INSERT` on `search_events` to `app_server`.

- [ ] **Step 1: Write failing tests.** RLS enabled and forced on both tables, one policy each, for `app_server` only; the existing `rls.test.ts` list of tables is extended by reading `pg_tables`, so it must pass unchanged; `app_server` can insert and select both tables and update `case_embeddings`; it cannot delete from either, and cannot update `search_events`; a role with no grants cannot read either; `(case_id, model)` is unique; a vector of the wrong length is rejected; `query_redacted` over 200 characters is rejected; `search_tsv` follows an update of a case's title and summary; an `HNSW` index exists on `embedding` (query `pg_indexes`; if PGlite cannot build it, the test documents that and the migration keeps it, see the risk in the spec); a keyword query with `to_tsquery` finds a case through the GIN-indexed column.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Schema files, `pnpm db:generate`, then append the generated-column, GIN, HNSW and security SQL to the new migration by hand. Check the migration runs in PGlite from a blank database and that `meta` stays consistent.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 embeddings and search events tables (AC-701, AC-703)`.

---

### Task 2: Configuration and the provider (AC-702, provider part)

**Files:** Modify `lib/config/env.ts`, `lib/config/constants.ts`, `.env.example`; Create `lib/embeddings/provider.ts`, `tests/helpers/embeddings.ts`; Test `tests/unit/embeddingProvider.test.ts`, `tests/unit/envOpenAi.test.ts`.

**Interfaces:**
- `env.ts`: `OPENAI_API_KEY` optional (non-empty when present), required when `APP_ENV` is production or staging; exposed as `openAiApiKey: string | null`. Error messages name the variable, never the value.
- `constants.ts`: `EMBEDDING = { model: "text-embedding-3-small", dimensions: 1536, requestTimeoutMs: 3000, cronTimeoutMs: 20000 }` and `SEARCH_TUNING = { legSize: 50, rrfK: 60, similarLimit: 3, minSimilarity: <placeholder, set in Task 8>, cronBatch: 25 }`.
- `provider.ts`: `interface EmbeddingProvider { model: string; dimensions: number; embed(texts: string[], options?: { timeoutMs?: number }): Promise<number[][]> }`; `createOpenAiProvider(apiKey, fetchImpl = fetch)` posting to the embeddings endpoint with the model, the input array and float encoding; throws a typed `EmbeddingError` with a code (`timeout`, `http`, `shape`, `network`) and no body, no input and no key; checks that the answer has one vector per input and each has the expected dimension; `getEmbeddingProvider()` returns the real one or `null` (server-only wiring, in a separate file so tests do not import the environment).
- `tests/helpers/embeddings.ts`: a recording fake provider that stores every input it receives and returns deterministic vectors (a hash-seeded unit vector, with an override to return a chosen vector per text), plus a throwing and a slow one.

- [ ] **Step 1: Write failing tests.** Provider: the request has the right URL, `Authorization` header, model and input array; a good answer returns the vectors in order; a wrong dimension, a missing item, a non-array and a malformed body are `shape` errors; a 4xx and a 5xx are `http` errors; an abort at the timeout is `timeout`; a rejected fetch is `network`; no error message, property or `JSON.stringify` of an error contains the key, the input text or the response body (sentinel values); an empty input array makes no request. Env: absent key is fine in development and test; present but empty is refused; required in production and staging; the error names `OPENAI_API_KEY` and never the value.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 embedding provider and configuration (AC-702)`.

---

### Task 3: Embedding input and storage (AC-702)

**Files:** Modify `lib/services/embeddingService.ts` (currently empty); Create `lib/embeddings/input.ts`; Test `tests/unit/embeddingInput.test.ts`, `tests/integration/embeddingService.test.ts`.

**Interfaces:**
- `input.ts`: `buildEmbeddingInput(c: Pick<Case, "title" | "summary" | "expected" | "actual" | "environment" | "tags">): string` (one labelled line per field; the environment contributes only `model`, `framework` and `language` when they are text; tags joined), `hashEmbeddingInput(model, input): string` (SHA-256 hex), `checkInput(input): { ok: true } | { ok: false; rules: string[] }` (runs the redactor and compares; the rule names, never the text).
- `embeddingService.ts`: `embedCase(db, provider, caseId, options?)` returning `{ status: "embedded" | "current" | "not_public" | "unsafe" | "failed" }`: reads the case, refuses a non-public one, builds and checks the input, skips when the stored hash is current, calls the provider, upserts the row; never throws for a provider failure; logs only the case id and a rule name list for `unsafe`. `findStaleCases(db, model, limit)` returns ids of public cases with no row or a different hash, oldest first.

- [ ] **Step 1: Write failing tests.** Input: stable for the same case; each field change changes the hash; environment keys other than the three, and non-text values, are left out; tags and a missing environment are handled; the input stays under a size bound for maximum-size fields. Service with the recording fake: embeds a public case and stores one row with the model, the dimension and the hash; the recorded text equals the built input; a second call is `current` and makes no provider call; a changed title makes it stale and a re-embed replaces the row (still one row); held, withdrawn and rejected cases are `not_public` and the provider receives nothing; a case whose stored text still holds a planted secret (inserted directly, simulating a gate gap) is `unsafe`, the provider receives nothing, and the log names the case id and rule but not the secret; a case whose stored text holds placeholders is sent with placeholders only (assert the recorded text contains `[REDACTED:` and none of the planted raw values, for each secret type in `tests/fixtures/secrets.json` sampled); a provider error is `failed` and writes nothing; `findStaleCases` lists missing and stale public cases only, oldest first, capped by the limit.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 embedding input, hash and storage (AC-702)`.

---

### Task 4: Hybrid search (AC-703, AC-704, AC-709)

**Files:** Modify `lib/services/searchService.ts`, `lib/services/observerService.ts` (the web search uses the keyword-only function); Create `lib/search/rank.ts`, `lib/search/query.ts`; Test `tests/unit/searchRank.test.ts`, `tests/unit/searchQuery.test.ts`, `tests/integration/searchService.test.ts`, extend `tests/integration/observerSearch.test.ts`.

**Interfaces:**
- `rank.ts`: `fuse(legs: string[][], k = 60): Array<{ id: string; score: number }>` (reciprocal rank fusion, stable ties), `resolvedFirst(items, isResolved)`.
- `query.ts`: `prepareQuery(raw): { text: string; redacted: number }` (cleaned and redacted: control characters out, secrets replaced by placeholders, trimmed, at most 200 characters).
- `searchService.ts`: `searchCases(db, viewerAgentId, query, deps?: { provider: EmbeddingProvider | null })` keeps its result type (`CaseListItem[]`); `searchKeyword(db, query)` runs the keyword leg alone (full text, then substring when nothing matches); the vector leg uses `<=>` cosine distance over public cases with an embedding for the provider's model. Returns list items only. `observerService.searchPublic` calls `searchKeyword`, so the page never embeds.

- [ ] **Step 1: Write failing tests.** Rank: a case in both legs outranks one in a single leg; a higher rank in one leg beats a lower rank in the other as the formula says; ties are stable; resolved cases come before others and keep their fused order within each group; one-element and empty legs. Query: a secret becomes a placeholder; control characters go; a query of only a secret yields a redacted text and a count; length is capped. Service with the fake provider and hand-built vectors: the vector leg finds a paraphrase that shares no words; the keyword leg finds an exact term; both together rank the case found by both first; resolved first; the limit applies; held, withdrawn and rejected cases never appear in either leg, even with the nearest vector or the best text match; a public case without an embedding is still found by keywords; `searchKeyword` finds "retries" from "retry" (stemming) and an error code by substring when full text finds nothing; with `provider: null` or a throwing or slow provider the keyword results come back and nothing throws; the provider receives the redacted query, never the raw one (planted secret); results never carry an `embedding` or a score property (walk the objects); the web search (`searchPublic`) never calls the provider (a provider that fails the test if called).
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 hybrid search with reciprocal rank fusion (AC-703, AC-704, AC-709)`.

---

### Task 5: The search route and search events (AC-707)

**Files:** Modify `lib/http/apiPipeline.ts` (`ApiDeps` gains `embedder`), `lib/http/handlers/cases.ts`, `lib/services/searchService.ts` or a new `lib/services/searchEventService.ts`; Test `tests/integration/searchHandler.test.ts`, extend `tests/integration/apiContract.test.ts` and `tests/unit/mcpTools.test.ts` where the search tool is covered.

**Interfaces:**
- `ApiDeps.embedder: EmbeddingProvider | null`; `getApiDeps()` fills it from `getEmbeddingProvider()`.
- `recordSearchEvent(db, { agentId, queryRedacted, resultCount, resolvedHit })`: inserts one row; swallows its own failure (logs the error class only).
- `handleSearchCases`: parses, calls `searchCases` with the provider, writes the event with the redacted query, answers as before.

- [ ] **Step 1: Write failing tests.** One request writes one `search_events` row with the agent, the redacted query, the count and `resolved_hit`; a planted secret in `q` appears nowhere in the table (scan the whole row text), in the provider's recorded input or in any log line; the raw query is not stored; a failing insert does not change the answer; a request with a bad `q` writes no row; the answer body is the same list envelope as before and carries no vector or score; the MCP search tool returns the same (through the real handler); a rate-limited request writes nothing; the provider off gives keyword results and still logs.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 search route logs redacted queries (AC-707)`.

---

### Task 6: Similar resolved cases on filing, and embedding on publish (AC-705)

**Files:** Modify `lib/http/handlers/cases.ts`, `lib/serializers/toAgentView.ts`, `lib/services/embeddingService.ts`, `lib/admin/actionsCore.ts` and `lib/admin/context` (embedder in the deps); Test `tests/integration/similarCases.test.ts`, extend `tests/integration/apiContract.test.ts`, `tests/integration/adminActions.test.ts`.

**Interfaces:**
- `embeddingService.embedAndFindSimilar(db, provider, caseId, { limit, minSimilarity })`: embeds the case (as `embedCase`), then returns up to `limit` resolved cases above `minSimilarity`, excluding the case, nearest first, as list items; `[]` when the provider is off, fails, times out, or the case is not public.
- `handleFileCase`: after `fileCase` and for a `201` only, calls it inside the request's transaction (bounded by the provider timeout) and adds `similar_resolved: [...]` (list views, in the same envelope) next to the case; a `202` has no embedding and `similar_resolved: []`. An idempotent replay returns the stored response, `similar_resolved` included.
- `moderateCore`: after an approved case commits, embed it best-effort (a failure changes nothing).

- [ ] **Step 1: Write failing tests.** Filing a clean case embeds it (one row) and returns the nearest resolved cases above the threshold, nearest first, never the new case itself, at most the limit, only resolved ones (open and argued neighbours are excluded however near); a held filing (`202`) writes no embedding, makes no provider call and returns `[]`; a blocked filing returns the same `422` as before; the provider off, throwing or slow still gives `201` with `[]`; the slow provider delays the answer by no more than the timeout; the response envelope walk from AC-307 still finds no free text outside `untrusted_content`, with the new list included; no vector or score in the body; an idempotent replay returns the identical body; an admin approving a held case embeds it, and a provider failure there still approves it; the MCP `court_file_case` result carries `similar_resolved` unchanged.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 similar resolved cases on filing (AC-705)`.

---

### Task 7: The re-embed cron (AC-706)

**Files:** Modify `lib/http/handlers/cron.ts`, `app/api/cron/reembed/route.ts`, `lib/services/embeddingService.ts`; Test `tests/integration/cronReembed.test.ts`, extend `tests/unit/cronRoutes.test.ts` (or the file that covers the cron routes).

**Interfaces:**
- `reembedStale(db, provider, { limit, timeoutMs, deadline })` returns counts only (`embedded`, `current`, `unsafe`, `failed`, `remaining`); stops at the deadline; idempotent.
- `handleCronReembed(request, deps)`: the same constant-time secret check and the same fixed `401` as the rescan route; `GET` and `POST`; answers with the counts only. `CronDeps` gains `embedder`.

- [ ] **Step 1: Write failing tests.** No secret, a wrong secret and a malformed header are the same `401` and do nothing; a good call embeds public cases that have no row, and re-embeds one whose text changed (simulating a redaction), and skips current ones; a held, withdrawn or rejected case is never embedded; the batch limit and the deadline are honoured and `remaining` reports the rest; a second call right after finds nothing to do; a provider that fails on one case leaves that case for the next run and embeds the others; the provider off answers `200` with zeros and a `disabled` flag; the answer holds counts only (no ids, no text, no vectors).
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the Next.js route handler guide first (`AGENTS.md`).
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 re-embed cron (AC-706)`.

---

### Task 8: Duplicate-recall evaluation (AC-708)

**Files:** Modify `tests/fixtures/duplicates-100.json` (currently empty), `package.json` (`eval:search`); Create `lib/search/evaluate.ts`, `scripts/eval-search.ts`; Test `tests/unit/searchEvaluate.test.ts`, `tests/unit/duplicatesFixture.test.ts`.

**Interfaces:**
- The fixture: 100 cases, 50 originals and 50 unrelated distractors, each with a stable id, title, summary, expected, actual and tags; and 50 queries, each a paraphrase of one original that shares few of its words, with the id of that original. All text is plain debugging content, with no secrets and nothing that resembles an instruction.
- `evaluate.ts`: `scoreRecall(results: Record<queryId, string[]>, truth: Record<queryId, string>, topN = 3): { hits: number; total: number; rate: number }`, plus a runner that, given a search function, runs every query and returns recall for it.
- `scripts/eval-search.ts` (`pnpm eval:search`): loads the fixture into an in-process test database (resolved status for the corpus), embeds it with the real provider from `.env.local`, then prints the top-3 recall of keyword-only, vector-only and hybrid, and the similarity of each true match, so `minSimilarity` can be chosen. It sends redacted fixture text only, prints counts and numbers only, and refuses to run without a key.

- [ ] **Step 1: Write failing tests.** Fixture: exactly 100 cases and 50 queries; unique ids; every truth id exists; no query equals its original's title or summary; paraphrase overlap is low (a bound on shared words); no text matches the gate's secret or injection patterns (run the real gate over every case and query: all `pass`, nothing redacted). Harness: `scoreRecall` on hand-made results (all hit, none, partial, hit at rank 4 does not count, an empty list); the runner with a fake search that returns the truth first gives a rate of 1 and with a fake that never does gives 0; the keyword leg alone over the fixture reaches a stated floor in CI (the floor is chosen after a first run and recorded in the test).
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the fixture. Then, with the owner's key in `.env.local`, run `pnpm eval:search` once (Task 9) and set `SEARCH_TUNING.minSimilarity` from the printed similarities.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N7 duplicate-recall fixture and evaluation (AC-708)`.

---

### Task 9: Live verification and close-out

**Files:** Modify `README.md`, `docs/ticket.md`, `docs/directory.md`, `docs/threats.md`, `.env.example`, `docs/build_plan.md` if a statement changed. A throwaway script in `scripts/` is deleted afterwards; the builder says so.

- [ ] **Step 1 (needs the owner):** the owner puts `OPENAI_API_KEY` in `.env.local`. The builder never reads or prints it; it checks that the variable exists by name and length only.
- [ ] **Step 2:** `pnpm eval:search`. Record the three recall numbers. AC-708 passes when hybrid reaches 80% or more. Set `minSimilarity` from the output and re-run the tests.
- [ ] **Step 3 (live pass, as in N4b to N6):** temporarily turn writes on, issue two throwaway keys, file a case that is a paraphrase of an existing resolved fixture-style case, and check `similar_resolved`; search through the REST route and the MCP tool with and without a paraphrase; call `/api/cron/reembed` with the secret and see the counts; confirm in the database, by counts and by column names only, that vectors exist and are never in any response; confirm a planted secret in a query shows as a placeholder in `search_events`; turn the key off and confirm the keyword fallback. Clean up exactly as before: withdraw public test cases, revoke keys, remove the flag, stop the server, delete the script and any temp files. Print counts and ids only.
- [ ] **Step 4:** Docs. README: a short "Search" section (the two legs, resolved first, `similar_resolved`, the key and the fallback, the cron). Ticket: AC-701 to AC-709 `done` with the measured recall, and the N7 row. Directory: the real files. Threats: the T8 and T10 status lines (what is sent, what is stored, how it is proved) and known gaps (the cron cadence and the stale window, no per-IP limit on the public page because it does not embed, the provider as a third party).
- [ ] **Step 5:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 6: Commit** `docs: N7 search notes`.
