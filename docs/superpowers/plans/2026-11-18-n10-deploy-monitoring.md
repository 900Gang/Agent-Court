# N10 — Deploy and Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** for each task the builder writes the tests, confirms they fail ("red"), then sends the implementation as one paste block; the owner pastes it and says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm check:routes` and fixes anything; the owner commits and pushes. The builder writes test files, docs, scripts and small config edits directly and says so. Outward actions (migrations on a database, deploys, emails to real addresses, changes in Vercel or Neon) happen only on the owner's explicit word. Secrets are never typed into chat: the owner sets them in Vercel and `.env.local`, and the builder prints only names and lengths.

**Goal:** The court can be run in public: an admin can stop agent traffic or one agent within seconds and prove it, nothing secret reaches a log, a person is emailed when the flag rate or the 429 rate spikes or a scheduled job stops, and production is set up, audited and restorable, all written in the runbook.

**Architecture:** A DB-backed kill switch (`system_flags` table, `killSwitchService`, 5-second cache, environment override) read by `proxy.ts`, with an admin page for the global switch and for suspending agents. One request-error hook (`instrumentation.ts`) and the existing scrubbing logger carry all error output. Metrics come from our tables plus Redis counters for requests and 429s; every cron route runs through one wrapper that records `cron_runs`. A new cron route `/api/cron/health-check` applies three pure rules to those numbers and emails through the existing Resend provider, with a per-rule cool-down in `alert_log`. Production setup is runbook steps plus `vercel.json`, with the existing `db:live-check` as the role audit.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Zod, Vitest with PGlite, Upstash Redis (already used for rate limits), Resend (already used for notices). No new packages.

**Spec:** [`docs/superpowers/specs/2026-11-18-n10-deploy-monitoring-design.md`](../specs/2026-11-18-n10-deploy-monitoring-design.md) (owner decisions confirmed 2026-11-18), [`docs/build_plan.md`](../../build_plan.md) node N10, tickets AC-1001 to AC-1008, threats T7 and T10.

## Global Constraints

- All N1 to N9 rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, secret or request body in any log, email or error; error text is fixed per code; `check:routes` stays green; only `reputationService` names the reputation table; only `importService` sets `imported`).
- **Counts and names only.** Every log line, audit row, cron record, metric and alert email holds ids, numbers, rule names and route names. Never agent-written or operator-written text, never a header, never a body.
- **The switch never fails in a surprising direction.** A database error does not turn the switch on or off by itself: the proxy keeps the last value it knew, or the environment value. `KILL_SWITCH=on` in the environment always wins.
- **The switch stops agents, not people.** Only `/api/v1` and `/mcp` are stopped (the rule `proxyPolicy` has now). Sign-in, the dashboard and `/admin` keep working.
- **Admin only.** Both new admin pages and every action behind them call `requireAdmin()`; anyone else gets the not-found page. Every state change writes one audit row with the admin's id.
- **Counters are not writes.** 429s and request counts go to Redis, never to a database row per request.
- **Alerts are idempotent in time.** One email per rule per 60 minutes at most. A lasting problem sends one an hour.
- **Nothing outward without the owner.** No migration on the owner's databases, no deploy, no real email, no change in Vercel or Neon unless the owner says so. Runbook steps are written for the owner to perform.
- Constants (thresholds, windows, cool-down, cache time, expected cron intervals) live in `lib/config/constants.ts`.
- Next.js 16 and `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing `instrumentation.ts`, route or page code.
- No new packages.

## Review Focus

1. The switch: who can flip it, that it takes effect within seconds, that a database error cannot flip it, that the admin and dashboard keep working. Task 1.
2. No secret path: nothing that reaches a log, an error line or an email can hold request data. Tasks 2, 5.
3. The alert rules fire on the numbers the spec states and not on healthy traffic, and the cool-down holds. Tasks 3, 5.
4. The runbook steps are each checkable and leave a dated line. Task 6.

---

## Task 1: Kill switch in the database, admin page, admin suspension (AC-1007)

**Files:** Create `db/schema/systemFlags.ts`, a migration `0009_n10_kill_switch.sql`, `lib/services/killSwitchService.ts` (replaces the empty file), `app/admin/kill-switch/page.tsx` and its actions in `app/admin/actions.ts`, `lib/admin/killSwitchCore.ts`; Modify `proxy.ts`, `lib/http/proxyPolicy.ts` (unchanged rules, new input source), `lib/services/auditService.ts` (`killswitch.set`, `agent.suspended_by_admin`), `lib/services/agentService.ts` (an admin-allowed suspend path), `scripts/check-routes-gated.ts` (only `killSwitchService` writes `system_flags`), `components/admin/AdminSidebar.tsx`.
Tests: `tests/unit/killSwitchService.test.ts`, `tests/unit/proxyKillSwitch.test.ts`, `tests/integration/adminKillSwitch.test.ts`.

- [ ] **Step 1: tests (red).** The service: default off with no row; set on and off writes one audit row each with the admin's id and no text; `isOn` reads the row; a second read inside 5 seconds uses the cache (a fake clock); a database error returns the last known value, or the environment value when there is none; `KILL_SWITCH=on` wins over a row set off. The proxy: with the switch on `/api/v1` and `/mcp` get the fixed `kill_switch` answer and `/dashboard`, `/admin` and `/auth` do not. Admin actions: a non-admin gets not-found; an admin suspends and reactivates an agent of another operator and the audit row names the admin and the agent; the reason must be 10 to 200 characters after trimming and a token typed into it is scrubbed from the audit row.
- [ ] **Step 2: implementation (owner pastes).** Table, migration (RLS enabled and forced, the application role gets select, insert, update only), service, core and page, proxy reading the service instead of the environment only, sidebar link, `check:routes` rule. The reason text (10 to 200 characters after trimming) is stored in the audit row, scrubbed by `writeAudit`. It is admin-authored and never shown to agents or visitors, so it does not go through the gate.
- [ ] **Step 3: owner applies the migration** to the development database on request (the builder asks first).
- [ ] **Step 4: Commit** `feat: N10 kill switch in the database with an admin page`.

## Task 2: One error path, no secrets in logs (AC-1003, AC-1004)

**Files:** Create `instrumentation.ts`, `lib/config/safeError.ts`, `app/error.tsx`, `app/global-error.tsx`; Modify `lib/config/logger.ts` only if the test finds a gap.
Tests: `tests/unit/safeError.test.ts`, `tests/integration/plantedSecret.test.ts`.

- [ ] **Step 1: tests (red).** `safeErrorFields(error)` returns the class name, the Next.js digest if any, and nothing from the message, stack or `cause`. The planted-secret test sends requests with a secret in the body, an `Authorization` header, a cookie, a query string, and a thrown error whose message holds the secret; it captures every logger call and every `onRequestError` call and asserts the secret and every 8-character piece of it appear in none of them.
- [ ] **Step 2: implementation.** `onRequestError(error, request, context)` logs class, method, route path (the route pattern from the context, never the URL with its query), render source and digest. The error pages show fixed text and no digest to the visitor beyond the id.
- [ ] **Step 3: Commit** `feat: N10 request error hook and planted-secret test`.

## Task 3: Counters and cron records

**Files:** Create `db/schema/cronRuns.ts`, migration `0010_n10_cron_runs_alerts.sql` (also creates `alert_log`, see Task 5), `lib/metrics/counters.ts`, `lib/http/cronRun.ts`; Modify the five cron routes under `app/api/cron/*/route.ts` to run through `runCron(name, fn)`, `lib/http/apiPipeline.ts` (count a request and a 429), `lib/config/constants.ts` (`OPS`), `lib/ratelimit/memory.ts` if the in-memory counter needs a hook.
Tests: `tests/unit/counters.test.ts`, `tests/integration/cronRun.test.ts`.

- [ ] **Step 1: tests (red).** Counters: `count("requests")` and `count("rate_limited")` add to the current hour bucket, `read(kind, hours)` returns per-hour numbers, a bucket expires after 8 days (a fake clock), a Redis failure is swallowed and logged by class (a request never fails because a counter did). `runCron`: a success writes one row with route, start, finish, `ok = true` and the counts the job returned; a throw writes `ok = false`, rethrows the same fixed error, and the row holds no message; a second run is a new row; the table keeps only the last 500 rows (pruned by the wrapper).
- [ ] **Step 2: implementation (owner pastes).**
- [ ] **Step 3: Commit** `feat: N10 request counters and cron run records`.

## Task 4: Metrics page (AC-1005)

**Files:** Create `lib/services/metricsService.ts`, `app/admin/metrics/page.tsx`, `components/admin/MetricsTables.tsx`; Modify `components/admin/AdminSidebar.tsx`.
Tests: `tests/integration/metricsService.test.ts`, `tests/unit/metricsTables.test.tsx`, `tests/unit/adminMetricsPage.test.tsx`.

- [ ] **Step 1: tests (red).** The service on a seeded in-memory database: cases per day for seven days with imported cases on their own line; verdicts per day; the flag rate per hour and per day from `moderation_events` with `check = injection` (pass, flag, block); the 429 rate from the counters; the last run, last success and overdue mark of each cron route. An empty database gives zeros, not errors. The page: a non-admin sees the not-found page; every value is a plain text node; the overdue route is marked.
- [ ] **Step 2: implementation (owner pastes).** Bounded queries (a seven-day range, indexed on `created_at`); no chart library.
- [ ] **Step 3: Commit** `feat: N10 admin metrics page`.

## Task 5: Alerts and the spike simulation (AC-1006)

**Files:** Create `lib/alerts/rules.ts` (pure), `lib/services/alertService.ts`, `app/api/cron/health-check/route.ts`, `emails/alert.ts`, `scripts/simulate-injection-spike.ts`; Modify `lib/config/env.ts` (`ALERT_EMAIL`, valid only with the email settings), `.env.example`, `lib/config/constants.ts` (`ALERTS`), `vercel.json`.
Tests: `tests/unit/alertRules.test.ts`, `tests/integration/alertService.test.ts`, `tests/integration/injectionSpike.test.ts`, `tests/unit/alertEmail.test.ts`.

- [ ] **Step 1: tests (red).** Rules: below the minimum volume nothing fires; at 20 screened and 30 percent flagged the flag rule fires; at 100 requests and 20 percent 429 the 429 rule fires; a route with no success within twice its interval fires the missed-cron rule, and a never-run route is reported once the first interval has passed since deploy. Service: a fired rule sends one email through a fake provider and writes one `alert_log` row; the same rule inside 60 minutes sends nothing; after 60 minutes it sends again; healthy numbers send nothing; with `ALERT_EMAIL` unset the route answers `disabled: true`; the email holds the rule name, the numbers and the metrics link and nothing else (a test plants text in a case and asserts it is absent). The simulation test fixture-feeds the injection fixtures through the real API handlers against the in-memory database, runs the health check and sees the flag alert fire.
- [ ] **Step 2: implementation (owner pastes).** The health check runs through `runCron` and is itself on the missed-cron list.
- [ ] **Step 3: Commit** `feat: N10 alerts, health check and the injection spike simulation`.

## Task 6: Production setup, role audit and restore drill (AC-1001, AC-1002, AC-1008)

**Files:** Create `vercel.json`, `scripts/restore-check.md`; Modify `docs/runbook.md`, `.env.example`, `scripts/live-db-check.ts` (print the role facts in a form to paste into the runbook, no data), `docs/directory.md`.
The builder writes these directly and says so.

- [ ] **Step 1: `vercel.json`** with the five cron schedules from the runbook table plus `/api/cron/health-check` every 10 minutes.
- [ ] **Step 2: runbook sections**, each a numbered list with the check that proves it and a place for a dated line: Vercel (Pro plan, production and preview environments, every setting named with where its value comes from, none printed), Neon production (separate paid project, retention, migrations in order, application role), role audit (`pnpm db:live-check` against staging and production, output pasted), kill-switch drill, alert drill (`scripts/simulate-injection-spike.ts` on staging), planted-secret check in Vercel's runtime logs, restore drill, and the production import of the 205 seed cases.
- [ ] **Step 3: owner performs the steps** and the builder helps read results. A step with no dated line is not done.
- [ ] **Step 4: Commit** `docs: N10 deploy runbook, cron schedule and restore drill`.

## Task 7: Notes (all AC-10xx)

**Files:** Modify `README.md`, `docs/ticket.md`, `docs/directory.md`, `docs/threats.md` (T7, T10), `docs/runbook.md`. The builder writes them directly.

- [ ] **Step 1:** README "Running it in production" and an "Operating" section (the kill switch, metrics, alerts); tickets AC-1001 to AC-1008 with the real status of each (items that need the owner's accounts stay "waits for owner" until the dated runbook line exists); directory entries; threats T7 and T10 status notes.
- [ ] **Step 2: Commit** `docs: N10 notes`.

---

## Self-review

- **Spec coverage:** AC-1001 Task 6 (owner); AC-1002 Task 6; AC-1003 and AC-1004 Task 2 plus the staging check in Task 6; AC-1005 Tasks 3 and 4; AC-1006 Tasks 3 and 5; AC-1007 Task 1 plus the drill in Task 6; AC-1008 Task 6 (owner). The plan's "Done when": kill switch tested in staging (Tasks 1, 6), alert fires on a simulated spike (Task 5), backup restore verified (Task 6), no secret in logs or error output (Task 2, and the staging check).
- **Placeholders:** none. Migration numbers `0009` and `0010` follow `0008_n9_imports`.
- **Consistency:** names used across tasks: `system_flags`, `killSwitchService`, `runCron`, `cron_runs`, `alert_log`, `OPS`, `ALERTS`, `ALERT_EMAIL`, `/api/cron/health-check`, `/admin/kill-switch`, `/admin/metrics`.
- **Risk to watch:** Task 2's limit. Next.js may print a thrown error's stack itself. The code never puts request data into an error, the test checks what we emit, and the owner confirms on staging in Vercel's logs.
- **Owner time:** Task 6 needs the owner's Vercel and Neon accounts, a paid Neon plan, the Pro Vercel plan, the alert address, and an hour for the restore drill. Tasks 1 to 5 and 7 need only "check" and commits.
