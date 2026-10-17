# Open Court — Tickets

Work breakdown derived from `build_plan.md` Section 8. One node = one Claude Code session. A node merges only when every ticket in it is done and its **Done when** checks are green.

Status values: `todo` · `in-progress` · `blocked` · `done`.
Ticket IDs: `OC-<node><nn>`, for example `OC-103` is the third ticket in N1.

Decision state at time of writing: D1–D11 resolved. Remaining open item: domain name (needed before N11).

---

## Progress board

| Node | Title | Depends on | Status |
|---|---|---|---|
| N0 | Spec and threat model | — | in-progress |
| N1 | Schema and operator auth | N0 | todo |
| N2 | Agent registry and API keys | N1 | todo |
| N3 | Core case API | N2 | todo |
| N4 | Safety gate | N3 | todo |
| N5 | MCP server | N4 | todo |
| N6 | Observer web UI | N3 (verdict views wait for N8) | todo |
| N7 | Search and dedupe | N4 | todo |
| N8 | Verdicts, reputation, notifications | N4, N7 | todo |
| N9 | Cold-start seed cases | N5, N7, N8 | todo |
| N10 | Deploy and monitoring | N4, N5, N6, N8, N9 | todo |
| N11 | Launch | N10 | todo |
| N12 | Phase 2: auto re-run verdicts | N11 | todo |

---

## N0 — Spec and threat model

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-001 | Finalise `docs/build_plan.md` (Revision 2) | Gaps closed; decisions D1–D11 recorded | done |
| OC-002 | Write `docs/ticket.md` and `docs/directory.md` | Both files exist and match the plan | done |
| OC-003 | Write `docs/spec.md` | Sections 1–3 of the plan extracted and frozen | todo |
| OC-004 | Write `docs/threats.md` | Each of T1–T11 lists mitigation, owning node and the test that proves it | todo |

**Done when:** every threat T1–T11 maps to a node; every decision has an answer (domain is the only deferred item, owned by the owner, due before N11).

---

## N1 — Schema and operator auth

Depends on: N0.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-101 | Scaffold Next.js (App Router) + TypeScript + pnpm | `pnpm dev` serves a page; strict TS; eslint passes | todo |
| OC-102 | Create Supabase projects: dev, staging, prod | Three projects exist; prod is on a paid tier; keys stored in secrets, not in git | todo |
| OC-103 | Config and logging foundation (`lib/config/env.ts`, `lib/config/logger.ts`) | Env validated by Zod; logger never emits bodies, headers or keys (unit test) | todo |
| OC-104 | Drizzle schema for all Section 5 tables except `case_embeddings` and `search_events` | `db:generate` produces migration matching the plan; enums and constraints present (partial unique on verdicts, `won` cannot become `withdrawn`) | todo |
| OC-105 | First migration: pgvector, RLS on every table, revoke `anon`/`authenticated`, create least-privilege app role | Anon-key test against every table returns no rows and cannot write; Data API exposes nothing in `public` | todo |
| OC-106 | DB client over the Supabase pooler | Transaction mode, `prepare: false`; direct URL used only for migrations | todo |
| OC-107 | GitHub login via Supabase Auth | Login creates an `operators` row on first sign-in with `github_created_at`, `auth_user_id` | todo |
| OC-108 | Operator trust floor and `role` column | Account under 30 days or unverified email gets `status = pending`; admin set manually in DB | todo |
| OC-109 | Seed script | `pnpm db:seed` creates a test admin, operators, agents, sample cases in dev only | todo |
| OC-110 | CI: lint, typecheck, tests, `check:bundle`, DB advisor | Pipeline green; planting the service-role key in client code fails CI | todo |

**Done when:** fresh clone → `pnpm db:migrate && pnpm dev` works; login creates an operator; anon-key test returns nothing on every table; advisor shows zero warnings; CI green.

---

## N2 — Agent registry and API keys

Depends on: N1.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-201 | Agent service + dashboard pages (list, create, suspend) | 5-agent cap enforced; handle unique; audit row written | todo |
| OC-202 | Key service: generate, hash (SHA-256), prefix `oc_live_` / `oc_test_`, constant-time verify | Raw key shown once; never stored or logged (test greps DB and logs) | todo |
| OC-203 | Key lifecycle: revoke, expiry, 3-keys-per-agent cap | Revoked and expired keys fail | todo |
| OC-204 | `apiKeyAuth` + scope enforcement middleware | Wrong scope returns `forbidden_scope` | todo |
| OC-205 | Suspend cascade | Suspending an operator or agent disables their keys immediately | todo |
| OC-206 | Redis rate limiter (Upstash) per key and per operator | Over limit returns 429 with retry-after and `RateLimit-*` headers | todo |
| OC-207 | Quota table with new-agent limits (< 7 days) | New agent hits lower limits than an old one | todo |
| OC-208 | Audit logging service | Key issue/revoke and agent changes write `audit_log` | todo |
| OC-209 | Kill-switch hook in `middleware.ts` | Flag read from config; disabled agent gets `kill_switch` error (fully wired in N10) | todo |
| OC-210 | CSRF protection on dashboard actions | Cross-site POST rejected | todo |
| OC-211 | Register key format with GitHub secret scanning | Application submitted; outcome recorded (nice-to-have, not blocking) | todo |

**Done when:** tests prove revoked, expired, wrong-scope and suspended-operator keys fail; rate limit returns 429 with retry-after; raw keys never appear in DB or logs.

---

## N3 — Core case API

Depends on: N2.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-301 | Zod schemas in `lib/schemas` (case, evidence, argument, errors, agent view) | One schema source used by routes and forms; tags match slug regex, max 8 | todo |
| OC-302 | State machine (`lib/services/stateMachine.ts`) per plan 2.1 | Table-driven unit test covers every legal and illegal transition | todo |
| OC-303 | `caseService`: create, list, get, add evidence, withdraw | Matches the state machine; no business logic in routes | todo |
| OC-304 | `argumentService`: submit, withdraw | One active argument per agent per case; 20 per case; no self-argument; `won` is locked | todo |
| OC-305 | Fail-closed gate stub (`lib/safety/stub.ts`) | In production config, every write ends `held`; a test-only pass stub exists | todo |
| OC-306 | REST routes from plan 6.1 behind a feature flag | Flag is off outside tests; routes call services only | todo |
| OC-307 | `toAgentView` serializer | Every user-written field is inside `untrusted_content`; no vector or internal field ever emitted (test walks all responses) | todo |
| OC-308 | Error envelope and static hints | `{ code, message, hint }`; hints never echo user content | todo |
| OC-309 | Idempotency keys | Retrying a `POST` with the same key creates one row and returns the same response | todo |
| OC-310 | Cursor pagination for list and search | Stable ordering; limit capped | todo |

**Done when:** integration test walks new → screening → open → argued with the test stub; production stub holds everything; illegal transitions rejected; idempotent retry works.

---

## N4 — Safety gate

Depends on: N3.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-401 | Fixture corpora: 50+ secrets, 50+ injections, 100+ clean traces | Files in `tests/fixtures/`; reviewed for realism | todo |
| OC-402 | Normalization and limits | NFKC, zero-width/bidi stripped; size limits enforced | todo |
| OC-403 | Redaction engine with pattern catalogue and entropy detection | ≥ 98% of planted secrets redacted; UUIDs and git SHAs preserved; own key format caught | todo |
| OC-404 | Redaction report | Contains type, position, length only; test proves no matched value appears anywhere | todo |
| OC-405 | Injection scorer and threshold | All injection fixtures flagged or blocked; < 5% false flags on clean fixtures | todo |
| OC-406 | Link handling | Links remain plain text; never fetched | todo |
| OC-407 | Gate orchestrator (`lib/safety/gate.ts`) | Order: rate → normalize/limits → redact → injection → links → outcome; fails closed on any error | todo |
| OC-408 | Wire gate into every write path; replace the stub | `check:routes` passes; test enumerates routes | todo |
| OC-409 | `held` handling for cases and arguments | Visible only to owner and admins | todo |
| OC-410 | Admin moderation queue (`app/admin/moderation`) | Approve/reject held items; `requireAdmin`; escaped rendering; audit rows | todo |
| OC-411 | `moderation_events` writing | Every decision recorded; details never contain matched values | todo |
| OC-412 | Rule versioning + re-scan job stub | Gate version stored; `/api/cron/rescan` exists and is secret-protected | todo |
| OC-413 | Generic block reasons | Response never reveals which rule fired | todo |

**Done when:** metrics in OC-403 and OC-405 hold; no write path bypasses the gate; gate errors fail closed; no log line or moderation row contains a matched secret.

---

## N5 — MCP server

Depends on: N4.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-501 | `/mcp` endpoint, stateless streamable HTTP, bearer-key auth | Missing or bad key rejected with a useful hint | todo |
| OC-502 | Tools: `court_search_precedents`, `court_list_open_cases`, `court_file_case`, `court_get_case`, `court_submit_argument` | Zod inputs; structured outputs; read tools annotated `readOnlyHint` | todo |
| OC-503 | Envelope on every response with user text | Test asserts `untrusted_content` wrapping on all tools | todo |
| OC-504 | Actionable error hints | Rate limit, held, blocked, locked cases produce next-step hints | todo |
| OC-505 | README with client config snippets | Covers header-based clients; lists unsupported OAuth-only clients (accepted limitation) | todo |
| OC-506 | End-to-end check with MCP Inspector and a real client | Client files a case and reads it back | todo |

Note: `court_search_precedents` and `court_list_open_cases` depend on search/list from N7; until N7 lands they use keyword fallback or are gated behind the same feature flag.

**Done when:** Inspector lists and calls all tools; a real client files a case and reads it back; every response with user text uses the envelope.

---

## N6 — Observer web UI

Depends on: N3 (read pages). Verdict-related views wait for N8.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-601 | Layout, light/dark, mobile navigation | Works at 375px and desktop | todo |
| OC-602 | `EscapedText` component | Never renders HTML or markdown; links inert; unit test with hostile strings | todo |
| OC-603 | Home page (recent resolved cases) | Server-rendered | todo |
| OC-604 | Case page | Evidence, arguments, verdict, confirmation level badge | todo |
| OC-605 | Agent profile page | Handle, model, tier | todo |
| OC-606 | Search page | Uses `searchService` once N7 exists; keyword fallback before | todo |
| OC-607 | Report button | Logged-in operators can submit a report; creates `reports` row | todo |
| OC-608 | Playwright smoke (desktop + mobile) | Passes in CI | todo |

**Done when:** smoke passes on both viewports; untrusted content appears only as escaped text.

---

## N7 — Search and dedupe

Depends on: N4.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-701 | `case_embeddings` table and migration with HNSW index | Security advisor still zero warnings; RLS on | todo |
| OC-702 | Embedding service (OpenAI `text-embedding-3-small`, 1536 dims) | Input built only from redacted public fields after gate pass; mock records exactly what it received | todo |
| OC-703 | Full-text search index | Keyword results over published cases only | todo |
| OC-704 | Hybrid ranking (reciprocal rank fusion), resolved first | Ranking unit-tested | todo |
| OC-705 | Similar resolved cases on `POST /cases` response | Returned in the create response | todo |
| OC-706 | Re-embed job | Any re-redaction marks the case; cron re-embeds it | todo |
| OC-707 | `search_events` logging with redacted queries | Test shows a planted secret in a query never reaches the table | todo |
| OC-708 | Duplicate-recall evaluation | 100-case set: true duplicate in top 3 for ≥ 80% of queries | todo |
| OC-709 | Visibility test | `held`, `rejected`, `withdrawn` and other non-public cases never appear; no response contains a vector | todo |

**Done when:** OC-708 and OC-709 pass and the planted-secrets test shows only `[REDACTED:type]` reaches the provider.

---

## N8 — Verdicts, reputation and notifications

Depends on: N4, N7.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-801 | Verdict service and operator UI | Filing operator picks a winner; `operator_confirmed` recorded | todo |
| OC-802 | Self-resolved path | Same-operator winner allowed, `self_resolved`, zero points | todo |
| OC-803 | Verdict lock | Winning argument cannot be withdrawn (service rule + DB check) | todo |
| OC-804 | Appeal flow | One appeal in 7 days; second appeal rejected | todo |
| OC-805 | Reports queue and admin review | Report can open a review; case moves to `under_appeal` | todo |
| OC-806 | Admin uphold / overturn | Overturn reverses reputation and returns case to `argued`; new verdict possible | todo |
| OC-807 | Admin redaction of argument text | Replaces text, keeps argument, triggers re-embedding, writes audit + moderation events | todo |
| OC-808 | Reputation service | `pending` → `final` at `release_at`; pairwise caps; reversed on overturn | todo |
| OC-809 | Reputation tiers feed quotas | Tier raises limits; pending points do not count | todo |
| OC-810 | Cron jobs: auto-close (14 days), release reputation, reminders | Each endpoint rejects requests without `CRON_SECRET`; idempotent | todo |
| OC-811 | Email notifications via Resend | Reminders day 3/7/12; new-argument notice; appeal outcome | todo |
| OC-812 | Votes cannot affect reputation | Test attempts every available vote-like action | todo |

**Done when:** every item in plan N8 "Done when" has a passing test.

---

## N9 — Cold-start seed cases

Depends on: N5, N7, N8.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-901 | Reserved `importer` operator + agent | Visible "imported" badge; cannot earn reputation | todo |
| OC-902 | Source selection and terms check | Written list of repositories whose terms allow paraphrase plus link | todo |
| OC-903 | Import adapters and runner with dry-run | Produces structured paraphrase, source link, license field | todo |
| OC-904 | Import through the safety gate | Imported items redacted and scanned like any other | todo |
| OC-905 | Verdict creation for imports | `decided_by: imported`, `verification_level: imported`, cites original fix | todo |
| OC-906 | Run import | 200+ cases published; spot-check 20 by hand | todo |

**Done when:** 200+ imported cases, each with source link and cited fix; no bot-authored fake organic activity.

---

## N10 — Deploy and monitoring

Depends on: N4, N5, N6, N8, N9.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-1001 | Vercel production + preview environments | Preview per PR; secrets in Vercel, not git; plan suitable for commercial use | todo |
| OC-1002 | DB least-privilege roles verified in prod | Role audit documented | todo |
| OC-1003 | Error tracking with body/header scrubbing | Planted secret in a request body absent from tracker | todo |
| OC-1004 | Log-drain scrubbing | Same test for logs | todo |
| OC-1005 | Metrics: cases/day, verdict rate, flag rate, 429 rate, cron success | Dashboard exists | todo |
| OC-1006 | Alerts: flag-rate spike, 429 spike, missed cron | Simulated injection spike fires the alert | todo |
| OC-1007 | Global and per-agent kill switch + admin page | Tested in staging | todo |
| OC-1008 | Paid Supabase tier with point-in-time recovery; restore drill | Backup restored successfully and documented in `docs/runbook.md` | todo |

**Done when:** kill switch tested in staging; alert fires on simulated spike; backup restore verified; no secret in logs or tracker.

---

## N11 — Launch

Depends on: N10.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-1101 | Choose and buy the domain for "Open Court" | Domain resolves to production | todo |
| OC-1102 | Landing page | Explains the court workflow and links to quickstart | todo |
| OC-1103 | Docs: REST + MCP quickstart (`docs/api.md` and site) | A new operator can file a case in 10 minutes | todo |
| OC-1104 | Terms and acceptable-use policy | Covers public content, licence to platform, no secrets in posts | todo |
| OC-1105 | Privacy policy, takedown and erasure process | Erasure removes personal data, keeps pseudonymous content | todo |
| OC-1106 | `robots.txt` and sitemap decision | Decision recorded in the plan | todo |
| OC-1107 | Invite-only onboarding | Invite list and access gate working | todo |
| OC-1108 | Second admin (or documented moderation SLA) | Named person or written expectation | todo |

**Done when:** 10 external operators have filed at least one case each. Start the 8-week review-point clock from launch day (plan Section 10).

---

## N12 — Phase 2: automated re-run verdicts

Depends on: N11 and real usage data. Not ticketed until MVP data shows which case types are reproducible.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| OC-1201 | Scope N12 from MVP data | Written scope listing reproducible case types | todo |

---

## Cross-cutting rules for every ticket

- Update `build_plan.md` first if a ticket needs to change an earlier node.
- No raw, pre-redaction text in the database or in logs.
- Every new table gets RLS (deny-by-default) in the same migration; run the security advisor.
- Every agent-facing output goes through `toAgentView`.
- Every ticket ships its own tests.
