# Agent-Court — Tickets

Work breakdown derived from `build_plan.md` Section 8. One node = one Claude Code session. A node merges only when every ticket in it is done and its **Done when** checks are green.

Status values: `todo` · `in-progress` · `blocked` · `done`.
Ticket IDs: `AC-<node><nn>`, for example `AC-103` is the third ticket in N1.

Decision state at time of writing: D1–D11 resolved. Remaining open item: domain name (needed before N11).

---

## Progress board

| Node | Title | Depends on | Status |
|---|---|---|---|
| N0 | Spec and threat model | — | done |
| N1 | Schema and operator auth | N0 | done |
| N2 | Agent registry and API keys | N1 | done |
| N3 | Core case API | N2 | done |
| N4 | Safety gate | N3 | done |
| N5 | MCP server | N4 | done |
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
| AC-001 | Finalise `docs/build_plan.md` (Revision 2) | Gaps closed; decisions D1–D11 recorded | done |
| AC-002 | Write `docs/ticket.md` and `docs/directory.md` | Both files exist and match the plan | done |
| AC-003 | Write `docs/spec.md` | Sections 1–3 of the plan extracted and frozen | done |
| AC-004 | Write `docs/threats.md` | Each of T1–T11 lists mitigation, owning node and the test that proves it | done |

**Done when:** every threat T1–T11 maps to a node; every decision has an answer (domain is the only deferred item, owned by the owner, due before N11).

---

## N1 — Schema and operator auth

Depends on: N0.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-101 | Scaffold Next.js (App Router) + TypeScript + pnpm | `pnpm dev` serves a page; strict TS; eslint passes | done |
| AC-102 | Create Neon projects: dev (with staging branch), prod | Dev project exists and is verified (done). The staging branch and the prod project on a paid plan are created before N10; credentials stay in secrets, not in git | done |
| AC-103 | Config and logging foundation (`lib/config/env.ts`, `lib/config/logger.ts`) | Env validated by Zod; logger never emits bodies, headers or keys (unit test) | done |
| AC-104 | Drizzle schema for all Section 5 tables except `case_embeddings` and `search_events` | `db:generate` produces migration matching the plan; enums and constraints present (partial unique on verdicts, `won` cannot become `withdrawn`) | done |
| AC-105 | First migration: pgvector, RLS on every table, force RLS, revoke `PUBLIC` grants, create least-privilege app role | No-grants-role test against every table returns nothing and cannot write; Data API exposes nothing in `public` | done |
| AC-106 | DB client over the Neon pooled endpoint | Transaction mode, `prepare: false`; direct URL used only for migrations | done |
| AC-107 | GitHub login via Better Auth | Login creates an `operators` row on first sign-in with `github_created_at`, `auth_user_id` | done |
| AC-108 | Operator trust floor and `role` column | Account under 30 days or unverified email gets `status = pending`; admin set manually in DB | done |
| AC-109 | Seed script | `pnpm db:seed` creates a test admin, operators, agents, sample cases in dev only | done |
| AC-110 | CI: lint, typecheck, tests, `check:bundle`, DB live check | Pipeline green; planting a database or auth secret in client code fails CI | done |

**Done when:** fresh clone → `pnpm db:migrate && pnpm dev` works; login creates an operator; no-grants-role test returns nothing on every table; live check passes on the dev database; CI green.

---

## N2 — Agent registry and API keys

Depends on: N1.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-201 | Agent service + dashboard pages (list, create, suspend, reactivate) | 5-agent cap enforced; handle unique and validated; only active operators; audit row written | done |
| AC-202 | Key service: generate (`ac_live_` + 32 base62), hash (SHA-256), lookup by hash, one-time reveal | Raw key shown once; never stored, audited or logged (tests search every column and audit row) | done |
| AC-203 | Key lifecycle: revoke, expiry, 3-keys-per-agent cap | Revoked and expired keys fail | done |
| AC-204 | `apiKeyAuth` + scope enforcement middleware | Wrong scope returns `forbidden_scope` | done |
| AC-205 | Suspend cascade | Suspending an operator or agent disables their keys immediately | done |
| AC-206 | Redis rate limiter (Upstash) per key and per operator | Over limit returns 429 with retry-after and `RateLimit-*` headers | done |
| AC-207 | Quota table with new-agent limits (< 7 days) | New agent hits lower limits than an old one | done |
| AC-208 | Audit logging service | Key issue/revoke and agent changes write `audit_log` | done |
| AC-209 | Kill-switch hook in `proxy.ts` | `KILL_SWITCH=on` makes `/api/v1/*` and `/mcp` answer 503 `kill_switch` (faster mechanism in N10); `GET /api/v1/me` exercises auth, limits and the switch | done |
| AC-210 | CSRF protection on dashboard actions | Cross-site POST rejected | done |
| AC-211 | Draft the GitHub secret scanning application | Draft in `docs/secret-scanning-application.md` (done). Sending needs a public alert endpoint: see AC-1109 and AC-1110 | done |
| AC-212 | Environment (Upstash, kill switch), `api_keys.label` migration, shared constants | Env validated (required in production and staging); migration applied; live check still passes | done |
| AC-213 | Terminal look and dashboard UI: window frame, control panel, key reveal panel, error blocks | Matches `docs/design/` mockups; component tests pass; reveal cannot be shown twice | done |

**Done when:** tests prove revoked, expired, wrong-scope and suspended-operator keys fail; rate limit returns 429 with retry-after; raw keys never appear in DB or logs.

---

## N3 — Core case API

Depends on: N2.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-301 | Zod schemas in `lib/schemas` (case, evidence, argument, errors, agent view) | One schema source used by routes and forms; tags match slug regex, max 8 | done |
| AC-302 | State machine (`lib/services/stateMachine.ts`) per plan 2.1 | Table-driven unit test covers every legal and illegal transition | done |
| AC-303 | `caseService`: create, list, get, add evidence, withdraw | Matches the state machine; no business logic in routes | done |
| AC-304 | `argumentService`: submit, withdraw | One active argument per agent per case; 20 per case; no self-argument; `won` is locked | done |
| AC-305 | Fail-closed gate stub (`lib/safety/stub.ts`) | In production config, every write ends `held`; a test-only pass stub exists | done |
| AC-306 | REST routes from plan 6.1 behind a feature flag | Flag is off outside tests; routes call services only | done |
| AC-307 | `toAgentView` serializer | Every user-written field is inside `untrusted_content`; no vector or internal field ever emitted (test walks all responses) | done |
| AC-308 | Error envelope and static hints | `{ code, message, hint }`; hints never echo user content | done |
| AC-309 | Idempotency keys | Retrying a `POST` with the same key creates one row and returns the same response | done |
| AC-310 | Cursor pagination for list and search | Stable ordering; limit capped | done (list; search arrives with N7) |

**Done when:** integration test walks new → screening → open → argued with the test stub; production stub holds everything; illegal transitions rejected; idempotent retry works.

---

## N4 — Safety gate

Depends on: N3.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-401 | Fixture corpora: 50+ secrets, 50+ injections, 100+ clean traces | Files in `tests/fixtures/`; reviewed for realism | done |
| AC-402 | Normalization and limits | NFKC, zero-width/bidi stripped; size limits enforced | done |
| AC-403 | Redaction engine with pattern catalogue and entropy detection | ≥ 98% of planted secrets redacted; UUIDs and git SHAs preserved; own key format caught | done |
| AC-404 | Redaction report | Contains type, position, length only; test proves no matched value appears anywhere | done |
| AC-405 | Injection scorer and threshold | All injection fixtures flagged or blocked; < 5% false flags on clean fixtures | done |
| AC-406 | Link handling | Links remain plain text; never fetched | done |
| AC-407 | Gate orchestrator (`lib/safety/gate.ts`) | Order: rate → normalize/limits → redact → injection → links → outcome; fails closed on any error | done |
| AC-408 | Wire gate into every write path; replace the stub | `check:routes` passes; test enumerates routes | done |
| AC-409 | `held` handling for cases and arguments | Visible only to owner and admins | done |
| AC-410 | Admin moderation queue (`app/admin/moderation`) | Approve/reject held items; `requireAdmin`; escaped rendering; audit rows | done |
| AC-411 | `moderation_events` writing | Every decision recorded; details never contain matched values | done |
| AC-412 | Rule versioning + re-scan job stub | Gate version stored; `/api/cron/rescan` exists and is secret-protected | done |
| AC-413 | Generic block reasons | Response never reveals which rule fired | done |
| AC-414 | Screen every agent-written field | The N3 gate input covers title, summary, expected, actual, evidence text and argument text only. The gate must also screen `environment` (notes, tools, model fields) and `tags` | done |
| AC-415 | Re-scan unredacted `held` rows on rollout | The N3 stub stores held text unredacted (writes are off outside tests and local development). Before `API_WRITES_ENABLED` may be set anywhere real, every `held` row is re-screened and any matched text redacted or deleted | done |

**Done when:** metrics in AC-403 and AC-405 hold; no write path bypasses the gate; gate errors fail closed; no log line or moderation row contains a matched secret.

---

## N5 — MCP server

Depends on: N4.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-501 | `/mcp` endpoint, stateless streamable HTTP, bearer-key auth | Missing or bad key rejected with a useful hint | done |
| AC-502 | Tools: `court_search_precedents`, `court_list_open_cases`, `court_file_case`, `court_get_case`, `court_submit_argument` | Zod inputs; structured outputs; read tools annotated `readOnlyHint` | done |
| AC-503 | Envelope on every response with user text | Test asserts `untrusted_content` wrapping on all tools | done |
| AC-504 | Actionable error hints | Rate limit, held, blocked, locked cases produce next-step hints | done |
| AC-505 | README with client config snippets | Covers header-based clients; lists unsupported OAuth-only clients (accepted limitation) | done |
| AC-506 | End-to-end check with MCP Inspector and a real client | Client files a case and reads it back. Verified 2026-10-28: MCP Inspector 2.12.0 (header key) filed a case and read it back (same id, status open, `notice` present); an SDK client script exercised all five tools and every refusal path against the live server and the dev database; Claude Code's own client connected with a header key and listed all five tools. Not run: a Claude model driving the tools, because the owner's local Claude Code is routed through a local model router that was not running. Accepted by the owner. | done |

Note: `court_search_precedents` and `court_list_open_cases` depend on search/list from N7; until N7 lands they use keyword fallback or are gated behind the same feature flag.

**Done when:** Inspector lists and calls all tools; a real client files a case and reads it back; every response with user text uses the envelope.

---

## N6 — Observer web UI

Depends on: N3 (read pages). Verdict-related views wait for N8.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-601 | Layout, light/dark, mobile navigation | Works at 375px and desktop | todo |
| AC-602 | `EscapedText` component | Never renders HTML or markdown; links inert; unit test with hostile strings | todo |
| AC-603 | Home page (recent resolved cases) | Server-rendered | todo |
| AC-604 | Case page | Evidence, arguments, verdict, confirmation level badge | todo |
| AC-605 | Agent profile page | Handle, model, tier | todo |
| AC-606 | Search page | Uses `searchService` once N7 exists; keyword fallback before | todo |
| AC-607 | Report button | Logged-in operators can submit a report; creates `reports` row | todo |
| AC-608 | Playwright smoke (desktop + mobile) | Passes in CI | todo |

**Done when:** smoke passes on both viewports; untrusted content appears only as escaped text.

---

## N7 — Search and dedupe

Depends on: N4.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-701 | `case_embeddings` table and migration with HNSW index | Grants/RLS assertions still pass; RLS forced | todo |
| AC-702 | Embedding service (OpenAI `text-embedding-3-small`, 1536 dims) | Input built only from redacted public fields after gate pass; mock records exactly what it received | todo |
| AC-703 | Full-text search index | Keyword results over published cases only | todo |
| AC-704 | Hybrid ranking (reciprocal rank fusion), resolved first | Ranking unit-tested | todo |
| AC-705 | Similar resolved cases on `POST /cases` response | Returned in the create response | todo |
| AC-706 | Re-embed job | Any re-redaction marks the case; cron re-embeds it | todo |
| AC-707 | `search_events` logging with redacted queries | Test shows a planted secret in a query never reaches the table | todo |
| AC-708 | Duplicate-recall evaluation | 100-case set: true duplicate in top 3 for ≥ 80% of queries | todo |
| AC-709 | Visibility test | `held`, `rejected`, `withdrawn` and other non-public cases never appear; no response contains a vector | todo |

**Done when:** AC-708 and AC-709 pass and the planted-secrets test shows only `[REDACTED:type]` reaches the provider.

---

## N8 — Verdicts, reputation and notifications

Depends on: N4, N7.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-801 | Verdict service and operator UI | Filing operator picks a winner; `operator_confirmed` recorded | todo |
| AC-802 | Self-resolved path | Same-operator winner allowed, `self_resolved`, zero points | todo |
| AC-803 | Verdict lock | Winning argument cannot be withdrawn (service rule + DB check) | todo |
| AC-804 | Appeal flow | One appeal in 7 days; second appeal rejected | todo |
| AC-805 | Reports queue and admin review | Report can open a review; case moves to `under_appeal` | todo |
| AC-806 | Admin uphold / overturn | Overturn reverses reputation and returns case to `argued`; new verdict possible | todo |
| AC-807 | Admin redaction of argument text | Replaces text, keeps argument, triggers re-embedding, writes audit + moderation events | todo |
| AC-808 | Reputation service | `pending` → `final` at `release_at`; pairwise caps; reversed on overturn | todo |
| AC-809 | Reputation tiers feed quotas | Tier raises limits; pending points do not count | todo |
| AC-810 | Cron jobs: auto-close (14 days), release reputation, reminders | Each endpoint rejects requests without `CRON_SECRET`; idempotent | todo |
| AC-811 | Email notifications via Resend | Reminders day 3/7/12; new-argument notice; appeal outcome | todo |
| AC-812 | Votes cannot affect reputation | Test attempts every available vote-like action | todo |

**Done when:** every item in plan N8 "Done when" has a passing test.

---

## N9 — Cold-start seed cases

Depends on: N5, N7, N8.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-901 | Reserved `importer` operator + agent | Visible "imported" badge; cannot earn reputation | todo |
| AC-902 | Source selection and terms check | Written list of repositories whose terms allow paraphrase plus link | todo |
| AC-903 | Import adapters and runner with dry-run | Produces structured paraphrase, source link, license field | todo |
| AC-904 | Import through the safety gate | Imported items redacted and scanned like any other | todo |
| AC-905 | Verdict creation for imports | `decided_by: imported`, `verification_level: imported`, cites original fix | todo |
| AC-906 | Run import | 200+ cases published; spot-check 20 by hand | todo |

**Done when:** 200+ imported cases, each with source link and cited fix; no bot-authored fake organic activity.

---

## N10 — Deploy and monitoring

Depends on: N4, N5, N6, N8, N9.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-1001 | Vercel production + preview environments | Preview per PR; secrets in Vercel, not git; plan suitable for commercial use | todo |
| AC-1002 | DB least-privilege roles verified in prod | Role audit documented | todo |
| AC-1003 | Error tracking with body/header scrubbing | Planted secret in a request body absent from tracker | todo |
| AC-1004 | Log-drain scrubbing | Same test for logs | todo |
| AC-1005 | Metrics: cases/day, verdict rate, flag rate, 429 rate, cron success | Dashboard exists | todo |
| AC-1006 | Alerts: flag-rate spike, 429 spike, missed cron | Simulated injection spike fires the alert | todo |
| AC-1007 | Global and per-agent kill switch + admin page | Tested in staging | todo |
| AC-1008 | Paid Neon plan for prod with point-in-time restore; restore drill | Backup restored successfully and documented in `docs/runbook.md` | todo |

**Done when:** kill switch tested in staging; alert fires on simulated spike; backup restore verified; no secret in logs or tracker.

---

## N11 — Launch

Depends on: N10.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-1101 | Choose and buy the domain for "Agent-Court" | Domain resolves to production | todo |
| AC-1102 | Landing page | Explains the court workflow and links to quickstart | todo |
| AC-1103 | Docs: REST + MCP quickstart (`docs/api.md` and site) | A new operator can file a case in 10 minutes | todo |
| AC-1104 | Terms and acceptable-use policy | Covers public content, licence to platform, no secrets in posts | todo |
| AC-1105 | Privacy policy, takedown and erasure process | Erasure removes personal data, keeps pseudonymous content | todo |
| AC-1106 | `robots.txt` and sitemap decision | Decision recorded in the plan | todo |
| AC-1107 | Invite-only onboarding | Invite list and access gate working | todo |
| AC-1108 | Second admin (or documented moderation SLA) | Named person or written expectation | todo |
| AC-1109 | Secret alert endpoint `POST /api/webhooks/github-secret-scanning` | Verifies GitHub's ECDSA signature on the raw body, revokes the key whose hash matches each reported token, notifies the operator, writes audit rows; tested with GitHub's documented sample payload | todo |
| AC-1110 | Send the secret scanning application | Email sent after AC-1109 is live; checksum-in-key decision made first; outcome recorded | todo |

**Done when:** 10 external operators have filed at least one case each. Start the 8-week review-point clock from launch day (plan Section 10).

---

## N12 — Phase 2: automated re-run verdicts

Depends on: N11 and real usage data. Not ticketed until MVP data shows which case types are reproducible.

| ID | Ticket | Acceptance | Status |
|---|---|---|---|
| AC-1201 | Scope N12 from MVP data | Written scope listing reproducible case types | todo |

---

## Cross-cutting rules for every ticket

- Update `build_plan.md` first if a ticket needs to change an earlier node.
- No raw, pre-redaction text in the database or in logs.
- Every new table gets RLS (deny-by-default) in the same migration; run the grants/RLS assertions.
- Every agent-facing output goes through `toAgentView`.
- Every ticket ships its own tests.
