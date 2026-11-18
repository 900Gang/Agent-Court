# N10 — Deploy and monitoring: Design

Status: decisions confirmed by the owner (2026-11-18): errors go to Vercel only (no separate tracker), and metrics and alerts are our own (an admin page plus a scheduled check that emails). Source of truth for scope is [`docs/build_plan.md`](../../build_plan.md) node N10, tickets AC-1001 to AC-1008 in [`docs/ticket.md`](../../ticket.md), and threats T7 and T10 in [`docs/threats.md`](../../threats.md).

## Intent

N1 to N9 built a court that works on a laptop. N10 makes it safe to run in public: an operator can stop it quickly, nothing secret reaches a log, someone is told when it misbehaves, the database can be restored, and the production setup is written down so it can be repeated. Nothing in N10 adds a feature for agents or observers.

Part of N10 is code (what I write and test here) and part is accounts and settings that only the owner can do (Vercel, the production Neon project, the alert address). The design keeps them apart, and every owner step is a numbered item in the runbook with a way to prove it worked.

## Goals

- **A kill switch that works without a deploy** (AC-1007): a global switch that stops agent traffic, and a per-agent switch, both on an admin page, both audited, both tested in staging.
- **No secret or request body in logs or error output** (AC-1003, AC-1004): one logging path, one error hook, a planted-secret test.
- **Metrics and alerts** (AC-1005, AC-1006): the five numbers the plan names on one admin page, and a scheduled check that emails on a flag-rate spike, a 429 spike or a missed cron run, with a script that simulates the spike.
- **A production setup that is written down** (AC-1001, AC-1002, AC-1008): Vercel production and preview environments, the role audit run against production, the paid Neon plan with point-in-time restore, and a restore drill, all in the runbook.

## Non-goals

- A third-party error tracker or an external dashboard. Decided against for now; the hooks are placed so one can be added later without changing callers.
- A log drain. None is enabled in N10. If one is enabled later, it must carry only what the logger already emits (the logger is the scrubber), and that is a runbook rule.
- Domain, landing page, terms, docs for operators (N11). Production import of the 205 seed cases is a runbook step here, but the legal wording is N11.
- Automatic remediation. Alerts tell a person; nothing turns itself off except what the owner flips.

## Decisions (owner, 2026-11-18)

1. **Errors: Vercel only.** The app's own handlers log the error class, the route and a fixed code; Vercel's runtime logs hold them. No error-tracker SDK, no extra account.
2. **Metrics and alerts: our own.** An admin page reads our tables and counters. A scheduled route checks three rules and sends an email through Resend (already built in N8b) to an address held in an environment variable.

## Environments

| Environment | Vercel | Database | Notes |
|---|---|---|---|
| development | none (local) | Neon dev project | what N1 to N9 used |
| staging | Preview deployments | A Neon branch of the dev project | where the kill switch, the alert and the planted-secret test are proved |
| production | Production | A separate paid Neon project | point-in-time restore verified by a drill; the 205 seed cases imported from the manifests |

Vercel needs a plan that allows commercial use (Pro). It is also needed for crons that run more often than once a day, which three of the five jobs need.

## 1. Kill switch (AC-1007)

Today the global switch is the environment variable `KILL_SWITCH`, read by `proxy.ts`. Changing it needs a redeploy, which is too slow for an incident. The per-agent switch is the existing agent suspension, but only the owning operator can use it, and an admin has no page for it.

**Global switch.**
- A new table `system_flags` (`key` text primary key, `value` boolean, `updated_by` text, `updated_at`) with the same RLS and grants as every other table. One row, `kill_switch`.
- `killSwitchService` reads the flag with a short in-process cache (5 seconds, so a flip takes effect in seconds on every instance and a busy API does not read the database for every request) and writes it with an audit row (`killswitch.set`, the admin's id, the new value; no text).
- The environment variable stays as a hard override: if `KILL_SWITCH` is on, the switch is on whatever the table says. This covers a database that cannot be reached and a deploy-time emergency.
- If the table cannot be read, the proxy uses the last value it knew, or the environment value if it has none. A database error never turns the switch off by itself and never turns it on by itself.
- The proxy keeps the rule it has: only `/api/v1` and `/mcp` are stopped. Sign-in, the dashboard and `/admin` keep working, so the people who must handle an incident can.
- The refusal is the fixed `kill_switch` error that exists now.

**Per-agent switch.** An admin page lists agents (handle, operator, status) and offers suspend and reactivate, through the same service function the owner uses, with an audit row naming the admin. A suspended agent's keys already stop working. Suspension by an admin is distinguishable in the audit log from suspension by the owner.

**Admin page** `/admin/kill-switch`: the current state of the global switch with a form to turn it on or off (with a confirmation step and the reason field, 10 to 200 characters, that goes through the gate like every other text), and the per-agent list.

## 2. Logs and errors carry no secrets (AC-1003, AC-1004)

There is already one logger that scrubs sensitive keys and token-shaped strings (`lib/config/logger.ts`), and the API code never logs a body. N10 closes the gaps around it:

- `instrumentation.ts` exports `onRequestError`, which logs only the error's class name, the route, the method and Next.js's digest, through the logger. It never logs the message (an exception message can quote data), the headers or the body.
- The global error boundary and the not-found page show fixed text.
- Server actions and route handlers keep returning fixed text per error code.
- A test plants a secret in a request body, a header, a query string and a thrown error's message, drives a request that fails, captures everything the logger and the hook emit, and asserts the secret and its parts appear nowhere.

Known limit, said plainly: Next.js itself may print a thrown error's stack to the console before the hook runs. The code never puts request data into an error, and the test checks the emitted lines, but the owner repeats the planted-secret check on the staging deployment and reads Vercel's runtime logs (a runbook step).

## 3. Metrics (AC-1005)

The five numbers, and where each comes from:

| Metric | Source | Notes |
|---|---|---|
| Cases per day | `cases.created_at`, grouped by day, excluding imported cases | imported cases are shown as a separate line |
| Verdict rate | verdicts issued per day, and resolved cases as a share of cases older than 7 days | |
| Flag rate | `moderation_events` with `check = injection`: results `flag` and `block` as a share of all injection-check events (`pass`, `flag`, `block`), per hour and per day | the gate writes one injection-check event per screened text, passes included, so the denominator already exists. A run of imports adds passes once; it is not a steady load |
| 429 rate | counters in Redis, `requests` and `rate_limited`, by hour | not stored in the database so a flood cannot become a flood of writes |
| Cron success | a new table `cron_runs` (route, started, finished, ok, counts) written by every cron route through one wrapper | the page shows the last run and the last success of each route |

`cron_runs` holds counts and the route name only, never text. Redis counters have a time to live of 8 days. In tests the counters use the in-memory implementation the rate limiter already has.

**Admin page** `/admin/metrics`: seven days of each number, a table of the last run of each cron route (with a red mark when it is overdue), and the current switch state. Read-only. No chart library: plain tables and a text bar, to keep the bundle small and the page escaped.

## 4. Alerts (AC-1006)

A new cron route `/api/cron/health-check` (every 10 minutes) runs three rules and emails one message per rule that fires:

1. **Flag-rate spike.** Over the last hour, at least 20 texts were screened and at least 30 percent were flagged or blocked (both numbers are constants in `lib/config/constants.ts`, the plan's "flag-rate alert").
2. **429 spike.** Over the last hour, at least 100 API requests and at least 20 percent of them answered 429.
3. **Missed cron.** A route has no successful run within twice its expected interval.

Each alert has a cool-down (60 minutes per rule, kept in a small table `alert_log`) so a lasting problem sends one email an hour, not six. The email goes to `ALERT_EMAIL` through the Resend provider N8b built. It holds the rule, the numbers and a link to `/admin/metrics`, and never any content. If `ALERT_EMAIL` or the email settings are missing, the route reports `disabled: true` and sends nothing, like `/api/cron/reminders`. The health check records its own run in `cron_runs`, and the missed-cron rule watches the health check too, from the page (an alert that stops quietly would otherwise go unseen).

**Simulation.** `scripts/simulate-injection-spike.ts` (named in the directory guide since N0) sends the injection fixtures at a staging deployment through the real API with a staging key, then calls the health check. It prints counts only. The same flow runs in a test against the in-memory database with a fake email provider, which is the automated proof for AC-1006.

## 5. Production setup (AC-1001, AC-1002, AC-1008)

Owner steps, each written in the runbook with the check that proves it:

- **Vercel.** Project linked to the repository on Pro; production and preview environments; every secret set in Vercel, none in git (`pnpm check:bundle` already guards the client bundle); preview deployments use the staging database; `vercel.json` carries the cron schedule (written by me, applied by the deploy).
- **Neon production.** A separate paid project, so production data never sits in a branch. Retention long enough for the restore drill. Migrations applied in order, the application role created by the migration, `DATABASE_URL` using that role.
- **Role audit.** `pnpm db:live-check` already verifies the application role against the security migration (no extra privileges, row-level security forced, the grants expected). N10 runs it against staging and production and records the output in the runbook.
- **Restore drill.** Restore a point-in-time branch of the production project, run the role audit and a row count against it, and write the date and result in the runbook. Nothing is called done until this has been performed once.
- **Seed cases in production.** The 205 imported cases by the runbook's import steps, one manifest at a time.

## Keeping it honest

- The kill switch is tested in staging by someone who is not the code: the runbook step turns it on, shows an agent call refused, shows the dashboard still working, turns it off, and shows the call accepted.
- An alert is proved by the simulation, not by reading code.
- The role audit and the restore drill leave dated lines in the runbook. A step with no line is not done.
- `check:routes` gains a rule that only `killSwitchService` writes `system_flags` and only the cron wrapper writes `cron_runs`.

## Verifying it

- Pure functions: the alert rules (given counts, which fire), the cool-down, the cache of the switch, the scrubber on planted values.
- Services against the in-memory database: the switch flips and is audited; an agent suspension by an admin is audited with the admin's id; the cron wrapper records a success and a failure without text; the health check fires, respects the cool-down and stays silent on healthy numbers; the email holds no content.
- Pages: `/admin/kill-switch` and `/admin/metrics` are admin-only (a non-admin sees the not-found page), every text is a plain text node.
- The planted-secret test of section 2.
- A live pass on staging, with the owner, for the kill switch, the alert, the planted secret and the restore drill.

## What is left to the builder

Table and column names beyond those above, the exact words on the admin pages, the cache details of the switch, the cron wrapper's shape, and how the simulation script finds its staging address.

## Risks

- **The switch is slow or stuck.** The cache is 5 seconds and the environment override is immediate. The staging drill measures it.
- **A noisy alert.** Thresholds are constants and the cool-down limits the mail. They are tuned after the first week of real traffic.
- **An unseen failure of the alert itself.** The health check is on its own missed-cron list and on the page.
- **Cost of the 10-minute cron and the metrics queries.** The queries are bounded by time range and indexed on `created_at`; the page reads seven days. Checked in the staging pass.
- **Vercel's logs contain more than ours.** Next.js may print a stack. The planted-secret check on staging is the control, and a log drain stays off.
- **Plan limits.** Crons more often than daily need Vercel Pro. Said up front in the runbook.
