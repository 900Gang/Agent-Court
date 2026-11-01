# N8b — Challenge, Review and Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** paste mode. For each task the builder sends the tests first as paste blocks; the owner pastes them and confirms they fail ("red"); the builder then sends the implementation as paste blocks; the owner says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm check:routes` and fixes anything; the owner commits and pushes. The builder writes files into the repository directly only for documents, for data fixtures and for the live verification in Task 8, and says so when it does. **One paste block per message** where possible: in N8a Task 6, blocks that came first in a message were lost twice.

**Goal:** A verdict can be challenged and undone, and the court keeps itself tidy. The filing operator can appeal once within 7 days. An admin can open a review from a report, uphold or overturn a challenged verdict (an overturn takes the points back and lets a new verdict follow), and redact text without leaving a hole in the record. Pending points become final on schedule, idle cases close after 14 days, and operators get a few plain emails about their own cases.

**Architecture:** `verdictService` gains `appealVerdict`; a new `reviewService` holds the admin side (`listReviewQueue`, `handleReport`, `decideReview`); a new `redactionService` holds `applyRedaction`; a new `lifecycleService` holds `closeIdleCases`. Every one of them locks the case row first and re-checks state inside the transaction, moves the case only through `nextState`, and writes an audit row and a moderation event in the same transaction. `reputationService.releaseDue` and `reverseForVerdict` (built in N8a) get their first callers. Email goes through a small provider interface (`lib/email`) with a Resend client over plain `fetch` and a recording fake. **Every email is sent by one cron job** (`/api/cron/reminders`) that scans for what is due and claims each notice in a `notification_log` row before sending, so no request path waits for a mail provider and a rerun cannot send twice. The three other cron routes call the services directly. Admin pages are thin and take their data from `lib/admin/*`.

**Tech Stack:** Next.js 16, React 19 server components and server actions, TypeScript strict, Drizzle, Vitest with PGlite. No new packages: templates render with `react-dom/server`, Resend is called with `fetch`.

> **Correction (2026-11-01, Task 7):** email templates are plain TypeScript functions in `emails/*.ts` that return escaped HTML (`lib/email/html.ts`), not React components rendered with `react-dom/server`: Next.js 16 rejects that import anywhere in a route's graph. The error code for "nothing to remove" in redaction is `nothing_to_redact`. The notice job leaves out what was already sent in its query, so a limit makes progress.

**Spec:** [`docs/superpowers/specs/2026-10-31-n8-verdicts-reputation-design.md`](../specs/2026-10-31-n8-verdicts-reputation-design.md) (owner decisions confirmed 2026-10-31), [`docs/build_plan.md`](../../build_plan.md) node N8 and sections 2.1 to 2.4, tickets AC-804 to AC-807, AC-810 and AC-811, [`docs/threats.md`](../../threats.md) (T5, T9). N8a (verdicts, reputation, tiers, dashboard) is committed.

## Global Constraints

- All N1 to N8a rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, secret or request body in any log or error; error text is fixed per code; `check:routes` stays green; only `reputationService` names `reputation_events`).
- **Humans decide, and admins review.** The filing operator appeals. Only an admin opens a review, upholds, overturns or redacts. No API route, MCP tool or agent key can do any of it. Every admin action is same-origin first, then the admin check (anyone else gets the answer a missing sign-in gets), then the service.
- **One transaction, the case row locked first.** A verdict, an appeal, a review, an upheld or overturned decision and an auto-close all lock the case row, re-read state inside the lock, and move the case only through `nextState`. Two at once: one wins, the other is refused with a fixed code, and a refusal writes nothing.
- **The appeal:** once per verdict, by the filing operator, within 7 days of the verdict (`REPUTATION.releaseDays`), on a `resolved` case whose verdict is `active`. The reason (10 to 500 characters) goes through the gate under a new `appeal` target; a flagged or blocked reason is refused with a fixed message. Pending points stay pending.
- **A review** can be opened by an admin from an open report whose target is a `resolved` case, or an argument on a `resolved` case, with an `active` verdict. Anything else can only be dismissed or marked reviewed.
- **Upheld:** the verdict is `active`, the case `resolved`, `appeal_outcome` `upheld`; the points stay pending until `release_at` and are released by the job as usual. **Overturned:** the verdict is `overturned` (kept as history), the winning argument becomes `overturned`, arguments that were marked `lost` by that verdict return to `active` unless the same agent now has another held or active argument on the case (then they stay `lost`), the case returns to `argued` through the state machine (and to `open` if no active argument is left), the reputation event becomes `reversed`. The overturned verdict stops being shown and a new verdict is possible.
- **Redaction** replaces text only with the fixed placeholder `[REDACTED:admin]`. An admin chooses the field and either an exact fragment or the whole text; no admin-typed text is ever stored in place of what was removed. Audit and moderation rows record who, which kind and field, and how many characters, never the removed text. A public case is re-embedded afterwards (outside the transaction, as `moderateCore` does); a failure changes nothing and the re-embed cron catches up.
- **Email goes to operators about their own cases only,** at the address stored at sign-in, and never contains agent-written text: fixed wording, ids, state names and links built from `BETTER_AUTH_URL`. A failed send is logged by error class and never fails a request or a job. Sending is on only when `RESEND_API_KEY` and `EMAIL_FROM` are both set. Each notice is claimed in `notification_log` first (unique on kind, target and operator), so a rerun sends nothing twice; a failed send releases its claim so the next run retries.
- **Cron routes:** the secret is checked first with the constant-time check, every refusal is the same fixed `401`, answers are counts only, every job is idempotent and works in bounded batches.
- **Auto-close** moves `open` and `argued` cases to `closed_unresolved` 14 days after publication. Held cases and cases with a verdict are never touched.
- Constants for the numbers live in one place (`LIFECYCLE` in `lib/config/constants.ts`, next to `REPUTATION`).
- Next.js 16 and `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing page or route code.
- No new packages.

## Review Focus

1. An overturn takes back exactly the points of that verdict, nothing else, and a new verdict can follow; a reversed event never counts toward the pairwise cap. Task 4.
2. No path publishes, un-redacts or rewrites text with anything but the fixed placeholder; no log, audit row, moderation row or email holds removed or agent-written text. Tasks 5, 7.
3. Races: two appeals, an appeal and an overturn, a verdict and an auto-close, two cron runs. Tasks 2, 4, 6, 7.
4. No request path waits for email, and a missing or broken provider changes nothing else. Task 7.

---

### Task 1: Constants, rules, `appeal` gate target, `notification_log` and its migration (AC-804, AC-810, AC-811 groundwork)

**Files:** Modify `lib/config/constants.ts`, `lib/config/env.ts`, `.env.example` (if present), `lib/safety/gate.ts`, `lib/safety/limits.ts`, `lib/services/auditService.ts`, `lib/services/moderationService.ts`, `db/schema/index.ts`, `db/migrations/0007_*.sql` and its `meta` files (generated); Create `lib/lifecycle/rules.ts`, `db/schema/notifications.ts`; Test `tests/unit/lifecycleRules.test.ts`, `tests/unit/appealLimits.test.ts`, `tests/integration/notificationSchema.test.ts`, extend `tests/unit/env.test.ts`-style tests for the two new settings.

**Interfaces:**
- `LIFECYCLE = { appealDays: 7, autoCloseDays: 14, reminderDays: [3, 7, 12], noticeWindowDays: 3, maxAppeal: 500, minAppeal: 10, cronBatch: 100 }`.
- `lib/lifecycle/rules.ts` (pure): `appealDeadline(verdictAt: Date): Date` (seven days later), `autoCloseAt(publishedAt: Date): Date` (fourteen days later), `reminderStage(publishedAt: Date, now: Date): 0 | 3 | 7 | 12` (the highest reminder day reached; 0 before day 3 and for a bad date), `withinNoticeWindow(eventAt: Date, now: Date): boolean` (an event older than 3 days, or in the future, is not announced; this keeps the first run after launch from mailing history).
- Env: `RESEND_API_KEY` and `EMAIL_FROM`, both optional; `getServerEnv()` exposes `resendApiKey` and `emailFrom`, null unless both are set (one without the other is a startup error in production and staging, a plain null elsewhere).
- Gate target `appeal`: `describeField("appeal", "text")` is limit 500, kind prose. Audit actions `appeal.filed`, `review.opened`, `verdict.upheld`, `verdict.overturned`, `report.handled`, `redaction.applied`, `case.closed`. Moderation targets already include `verdict`.
- `notification_log(id, kind, target_id, operator_id, created_at)`, unique on `(kind, target_id, operator_id)`. `SELECT, INSERT, DELETE` (the delete is how a failed send gives its claim back). RLS forced, one policy for `app_server`, as every table.

- [ ] **Step 1: Write failing tests.** Rules: each boundary of `reminderStage` (day 2.99, 3, 6.99, 7, 11.99, 12, 400), a future or invalid date gives 0, deadlines are exact, the notice window edges. Appeal limits: the gate knows `appeal.text` as 500 characters of prose, refuses 501, redacts a secret. Schema: a duplicate `(kind, target_id, operator_id)` is rejected (23505), `app_server` can insert, read and delete but not update, RLS forced with one policy, the existing RLS and grants tests still pass. Env: only one of the two email settings in production fails startup with a message that names the setting and quotes no value; both unset is fine everywhere.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Constants, rules, env, gate target, audit types, the table in the schema, `pnpm db:generate --name n8b_notifications`, check the generated SQL creates only the table, its unique index and the grants and RLS lines the repository's other tables carry (add them by hand to the migration in the same style if drizzle-kit does not emit them).
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b lifecycle rules, appeal gate target and notification log (AC-804)`.

---

### Task 2: The appeal (AC-804)

**Files:** Modify `lib/services/verdictService.ts`, `lib/services/operatorCaseService.ts`, `lib/dashboard/messages.ts`, `lib/dashboard/data.ts`, `components/dashboard/CaseRow.tsx`; Create `lib/schemas/appeal.ts`, `lib/dashboard/appealCore.ts`, `app/dashboard/cases/[id]/appeal/page.tsx` (fill the stub), `components/dashboard/AppealForm.tsx`; extend `app/dashboard/cases/actions.ts`; Test `tests/unit/appealInput.test.ts`, `tests/integration/appealService.test.ts`, `tests/integration/appealAction.test.ts`, `tests/unit/appealForm.test.tsx`, extend `tests/unit/dashboardCasesPages.test.tsx` and `tests/integration/operatorCaseService.test.ts`.

**Interfaces:**
- `parseAppealInput(raw)` → `{ caseId, reason }`, the reason trimmed, 10 to 500 characters, field names in the refusal only.
- `appealVerdict(db, gate, operator, raw, now?)`: order: operator active (read live) → parse → reason through the gate (`appeal` target, refusal `{ reason: REASON_REFUSED }`) → transaction: lock the case; it is the operator's own (else `not_found`, the same as unknown); it is `resolved` with a live verdict whose status is `active` (else `illegal_transition`); the verdict has not been appealed (`appealed_at` null, else `already_appealed`); `now` is not after `appealDeadline(verdict.createdAt)` (else `appeal_window_closed`). Then the verdict becomes `under_appeal` with `appealed_at` and `appeal_reason`, the case moves through `nextState(resolved, "appeal")`, one audit row `appeal.filed` (metadata: case id, no reason), one moderation event. Pending points are untouched. Errors: `invalid | not_found | operator_not_active | illegal_transition | already_appealed | appeal_window_closed`.
- `getAppealFormView(db, operatorId, caseId)` in `operatorCaseService`: the case title, the verdict level and date, the deadline; null for a case that is not the operator's, not resolved, already appealed or past the window (so the page is the not-found page).
- The cases list row gains a state label `APPEAL OPEN UNTIL <date>` and an `APPEAL` link only while an appeal is possible; an appealed case shows `UNDER APPEAL`.
- `appealCore(deps, formData)` and `appealRedirect(result, submittedCaseId)` follow `verdictCore`: same-origin first, then signed in, then the service; fixed messages (new codes `already_appealed`, `appeal_window_closed`, `case_not_resolved`); redirects built from fixed text and a checked UUID. `appealAction` in `cases/actions.ts`.
- `/dashboard/cases/[id]/appeal`: the case title and verdict as text, a reason box (10 to 500), and the plain statement that an appeal can be made once and an administrator will decide.

- [ ] **Step 1: Write failing tests.** Input: bounds 9, 10, 500, 501, blank, wrong types, a hostile reason kept as data. Service: success writes everything and nothing else (verdict, case, audit without the reason, moderation event, points still pending and not final); every refusal writes nothing (not the operator's case, another operator, unknown id, case not resolved, verdict overturned, second appeal, one second past the deadline accepted and one second after refused, suspended and pending operator, gate refusal, secret in the reason redacted before it is stored); two simultaneous appeals leave exactly one; an appeal and `releaseDue` together never release points of an appealed verdict; the reason is never in the audit row, the moderation row, a log line or the answer. Action: origin, sign-in and each refusal map to a fixed message and write nothing; a forged case id cannot redirect off the site. Pages and form: the reason field limits, the statement, hostile text as text, the 404 page for a case that cannot be appealed; the list shows the label and the link only while allowed.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the dashboard pages and `AGENTS.md` first.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b the appeal (AC-804)`.

---

### Task 3: Reports review and the admin queue for appeals (AC-805)

**Files:** Create `lib/services/reviewService.ts`, `lib/admin/reviewData.ts` (server-only wrapper), `lib/admin/reviewCore.ts`, `components/admin/ReportItem.tsx`, `components/admin/AppealItem.tsx`, `app/admin/reports/page.tsx` and `app/admin/appeals/page.tsx` (fill the stubs); Modify `components/admin/AdminSidebar.tsx`, `lib/dashboard/messages.ts`, `app/admin/actions.ts`; Test `tests/integration/reviewService.test.ts`, `tests/integration/reviewAction.test.ts`, `tests/unit/adminReviewPages.test.tsx`, extend `tests/unit/ui.test.tsx` (sidebar).

**Interfaces:**
- `listReports(db, { limit })` → open reports, oldest first: id, date, target type, target id, the case id and title the target belongs to, the case state, whether a review can be opened (target is a `resolved` case or an argument on one, with an `active` verdict), the reason (reporter free text, already gated at filing; shown as text only), and the reporter's display name is **not** included. Capped at 50 with a `truncated` flag.
- `listAppeals(db, { limit })` → verdicts that are `under_appeal`: case id and title, the verdict level and date, how it came to be under review (`appeal` with the operator's reason, or `review` from a report), the points pending. Capped as above.
- `handleReport(db, admin, { reportId, decision })` with `decision` one of `dismiss`, `reviewed`, `open_review`; the admin is active and an admin (read live); one transaction: the report is `open` (else `illegal_transition`; unknown id `not_found`); `dismiss` → `dismissed`, `reviewed` → `reviewed`; `open_review` → the case row is locked, it is `resolved` with an `active` verdict (else `illegal_transition`), the verdict becomes `under_appeal`, the case moves through `nextState(resolved, "review_opened")`, and the report becomes `actioned`. Audit `report.handled` (decision and report id) and, for a review, `review.opened`; a moderation event on the case or argument. Nothing the reporter wrote reaches an audit row.
- `reviewCore` follows `moderateCore`: same-origin first, then the admin check (anyone else gets the missing-sign-in answer), then input, then the service; fixed messages for every code; a redirect back to `/admin/reports?error=<code>`.
- Admin sidebar: REPORTS and APPEALS become links; REDACT and KILL SWITCH stay as they are until Task 5.

- [ ] **Step 1: Write failing tests.** Lists: only open reports, oldest first, capped with the flag, the reason present as stored, no reporter identity or operator id, `canOpenReview` true only for a resolved case or an argument on one with an active verdict; appeals list: only `under_appeal`, the two origins distinguished, points pending shown. `handleReport`: each decision's effect and nothing else; a second decision on the same report refused; `open_review` on an open case, a withdrawn case, an overturned verdict, a verdict already under appeal, an evidence-less unknown target: refused with nothing written; two admins deciding the same report at once leave one winner; a non-admin, a suspended admin and a pending operator are refused with the missing-sign-in answer. A review opened from a report stops `releaseDue` for that verdict. Actions and pages: origin before admin, fixed messages, the reason and titles shown as text, hostile text inert, only admin links.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b reports review and the appeals queue (AC-805)`.

---

### Task 4: Uphold and overturn (AC-806)

**Files:** Modify `lib/services/reviewService.ts`, `lib/admin/reviewCore.ts`, `components/admin/AppealItem.tsx`, `app/admin/actions.ts`, `lib/dashboard/messages.ts`; Test `tests/integration/decideReview.test.ts`, extend `tests/integration/reviewAction.test.ts`, `tests/unit/adminReviewPages.test.tsx`.

**Interfaces:**
- `decideReview(db, admin, { caseId, decision })`, `decision` one of `uphold`, `overturn`: admin active and admin (live) → one transaction: lock the case; it is `under_appeal` with a verdict that is `under_appeal` (else `illegal_transition`; unknown `not_found`).
  - **uphold:** verdict `active`, `appeal_outcome` `upheld`, `appeal_resolved_at` now; case `resolved` through `nextState(under_appeal, "upheld")`; the points are untouched (the release job releases them at `release_at` or on its next run after it).
  - **overturn:** verdict `overturned`, `appeal_outcome` `overturned`, `appeal_resolved_at` now; the winning argument `overturned`; arguments that are `lost` return to `active`, except one whose agent now has another held or active argument on the case; the case moves through `nextState(under_appeal, "overturned")` (`argued`), and if no active argument remains, on through `all_arguments_withdrawn` to `open`; `reverseForVerdict` turns the event `reversed`.
  - Audit `verdict.upheld` or `verdict.overturned` (case and verdict ids, counts of arguments restored, never text) and a moderation event.
- The admin appeals page gains an `UPHOLD` and an `OVERTURN` button per item, each a plain form post with a fixed confirmation sentence next to it.
- New fixed messages: `review_not_found`, `review_not_open`.

- [ ] **Step 1: Write failing tests.** Uphold: only the three changes above, points still pending, `releaseDue` after `release_at` releases them. Overturn: every change above; the reversed event no longer counts toward the pairwise cap (the same pair earns the next full award); the tier falls on the next request; `GET /cases/:id` shows `verdict: null` and the case as `argued`; the case is no longer a `similar_resolved` result and not first in search as resolved; a new verdict can be issued by the same operator and earns points; restoring does not collide with an agent that argued again meanwhile (the unique index is never hit); a case whose only other argument was withdrawn goes to `open`; withdrawn arguments stay withdrawn. Refusals write nothing: wrong state, already decided, unknown case, non-admin, suspended admin; two simultaneous decisions leave one outcome; an overturn and `releaseDue` together never leave a `final` event on an overturned verdict.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b uphold and overturn with reversal (AC-806)`.

---

### Task 5: Admin redaction (AC-807)

**Files:** Create `lib/services/redactionService.ts`, `lib/admin/redactCore.ts`, `components/admin/RedactForm.tsx`, `app/admin/redact/page.tsx` (fill the stub); Modify `components/admin/AdminSidebar.tsx`, `lib/dashboard/messages.ts`, `app/admin/actions.ts`; Test `tests/integration/redactionService.test.ts`, `tests/integration/redactAction.test.ts`, `tests/unit/redactForm.test.tsx`, extend `tests/unit/adminReviewPages.test.tsx`.

**Interfaces:**
- `REDACTION_PLACEHOLDER = "[REDACTED:admin]"` and the fields that can be redacted: argument `reasoning` and `proposedChange`, evidence `text` (stored as `redacted_text`), case `title`, `summary`, `expected`, `actual`.
- `applyRedaction(db, admin, { targetType, targetId, field, fragment })`: `fragment` is a non-empty exact string to remove, or `null` to blank the whole field. Admin active and admin (live); target and field valid; one transaction: the row is locked; with a fragment, every occurrence is replaced by the placeholder and a fragment that is not present is refused (`fragment_not_found`); with `null`, the whole field becomes the placeholder. Argument rows get `redacted_at`. Status, verdict and everything else stay. Audit `redaction.applied` and a moderation event, both with the target type, the field and the number of characters removed, never the text. Returns `{ caseId, removed }`.
- After the transaction, for a public case, `embedCase` runs (as `moderateCore` does) when an embedder is configured; a failure changes nothing.
- `redactCore` follows `moderateCore`; `/admin/redact` is a form (target kind, id, field, fragment box with the hint "leave empty to blank the whole field"), and shows, after a success, only the count removed.

- [ ] **Step 1: Write failing tests.** Every field of every kind, with fragment and with blanking; several occurrences; a fragment that straddles nothing and is absent (refused, nothing written); a fragment that equals the whole text; an empty string means blanking only when `null` is sent by the form's explicit control, never by accident (an empty text box with the "blank" box unticked is `invalid`); the placeholder appears literally and nothing else is added; text typed by the admin is never stored; the argument stays with its status, and a `won` argument keeps its verdict; the audit and moderation rows and every log line hold no removed text (planted marker test); a case field redacted changes the text hash, the vector is replaced and search no longer finds the removed words (recording provider shows what it received and that it held the placeholder); an argument redaction leaves the vector as it was (the call finds the case current); a failing provider changes nothing; non-admin, suspended admin and cross-site posts refused; unknown targets and malformed ids refused with fixed codes; a held case can also be redacted and stays held.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b admin redaction with re-embedding (AC-807)`.

---

### Task 6: The three scheduled jobs (AC-810)

**Files:** Create `lib/services/lifecycleService.ts`; Modify `lib/http/handlers/cron.ts`, `app/api/cron/auto-close/route.ts`, `app/api/cron/release-reputation/route.ts` (fill the stubs); Test `tests/integration/lifecycleService.test.ts`, `tests/integration/cronLifecycle.test.ts`.

**Interfaces:**
- `closeIdleCases(db, now, { limit })`: cases that are `open` or `argued` with `published_at` at least 14 days before `now`, oldest first, up to `limit`; each in its own transaction that locks the row and re-checks state, moves through `nextState(…, "timeout")`, writes audit `case.closed`; skipped silently if the state changed meanwhile. Returns `{ closed: number, remaining: number }` and the closed case ids for the notice job to find (it finds them by state and date, not by a list).
- `handleCronAutoClose(request, deps)` and `handleCronReleaseReputation(request, deps)` in `lib/http/handlers/cron.ts`: the secret check first, the same fixed `401`, counts-only answers: `{ closed, remaining }` and `{ released }` (the latter from `releaseDue`). GET and POST accepted as for the other cron routes.

- [ ] **Step 1: Write failing tests.** Auto-close: a case published 14 days ago closes, 13 days 23 hours does not; `open` and `argued` both; `held`, `resolved`, `under_appeal`, `withdrawn`, `rejected` never; a case with a verdict is never closed even if it is somehow `open`; batch limit with `remaining`; running twice closes nothing the second time; a verdict issued while the job runs wins or loses cleanly (the case is either `resolved` or `closed_unresolved`, never both); the audit row holds ids only. Release: events due and verdict `active` become `final` and the tier rises on the next request; events not due, under appeal, overturned or already `final` or `reversed` are untouched; idempotent. Routes: no secret, wrong secret, wrong scheme, empty secret configured: the same `401` with the same body, and nothing changes in the database; a correct call answers counts only; no response contains a case id or title.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b auto-close and release jobs (AC-810)`.

---

### Task 7: Email: provider, templates, notices and the reminders job (AC-811)

**Files:** Create `lib/email/provider.ts`, `lib/email/server.ts`, `lib/email/render.ts`, `emails/reminder.tsx`, `emails/newArgument.tsx`, `emails/appealOutcome.tsx`, `emails/caseClosed.tsx`, `tests/helpers/email.ts`; Modify `lib/services/notificationService.ts`, `lib/http/handlers/cron.ts`, `app/api/cron/reminders/route.ts` (fill the stub); Test `tests/unit/emailProvider.test.ts`, `tests/unit/emailTemplates.test.tsx`, `tests/integration/notificationService.test.ts`, `tests/integration/cronReminders.test.ts`.

**Interfaces:**
- `EmailProvider = { send(message: { to: string; subject: string; html: string; text: string }): Promise<void> }`; a Resend client over `fetch` (`POST https://api.resend.com/emails`, bearer key, a timeout, typed errors `timeout | rejected | unavailable` that carry no key, address or body); `getEmailProvider()` returns null unless `resendApiKey` and `emailFrom` are set. `tests/helpers/email.ts`: `createRecordingMailer()` (records every message, can be told to fail the next send) and a throwing and a slow one.
- Templates are plain React components that take **ids, state names, dates and a base URL only**; `renderEmail(element)` returns `{ html, text }` through `renderToStaticMarkup`. Four kinds: `reminder` (days 3, 7, 12: "N argument(s) are waiting on case <id>, link"), `new_argument` (a new argument is on case <id>, link), `appeal_outcome` (upheld or overturned, link), `case_closed` (closed unresolved, link). Fixed subjects, no title, summary, handle or any agent-written text.
- `sendDueNotices(db, provider, now, { baseUrl, limit })` in `notificationService`: finds, in one bounded pass each, (1) `argued` cases whose `reminderStage` is 3, 7 or 12 and that still have an active argument; (2) active arguments created within the notice window on cases that are still public; (3) verdicts whose appeal was resolved within the window; (4) cases closed unresolved within the window; for each, the recipient is the filing operator (active, not deleted, with an address); it claims `(kind, target, operator)` in `notification_log` (`insert … on conflict do nothing returning`), sends only if it got the claim, and **deletes the claim when the send fails** so the next run retries. Reminders use the highest stage reached and the kind carries the stage (`reminder_3`, `reminder_7`, `reminder_12`), so a late first run sends one reminder, not three. Returns counts only: `{ sent, failed, skippedNoAddress, alreadySent, disabled }`.
- `handleCronReminders(request, deps)` in `cron.ts`: the secret check first; with no provider answers `200` with `disabled: true` and zeros (as `reembed` does); otherwise the counts. `CronDeps` gains `mailer?`.

- [ ] **Step 1: Write failing tests.** Provider: the request the client builds (URL, method, headers, body fields), a 2xx is success, 4xx and 5xx and a timeout and a network error are typed errors that hold no key, address or body, the real provider is null without both settings. Templates: every template rendered with hostile ids, handles and titles shows none of that text (the templates cannot receive it), contains no `<script`, links are only `BETTER_AUTH_URL` plus a checked UUID path, plain text and HTML both present. Service: each of the four kinds sends once and a rerun sends nothing; day 3, 7 and 12 boundaries; a case with no active argument gets no reminder; the highest stage only after downtime; events older than the window or in the future are not announced; recipients: the filing operator only, never the arguer or an admin, never an operator without an address, suspended or deleted; a failed send releases the claim and the next run sends it; two runs at once send once; the recording mailer shows no agent-written text for a hostile case (planted marker in title, summary, argument and handle never appears in any message); a throwing provider changes no case, argument or verdict. Cron route: the secret check, the same `401`, counts only, `disabled` without a provider, idempotent; a mail failure still answers `200` with the count in `failed`.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N8b email notices and the reminders job (AC-811)`.

---

### Task 8: Live pass and notes

**Files:** Create (temporary, deleted afterwards) `scripts/tmp-live-n8b.ts`; Modify `README.md`, `docs/ticket.md`, `docs/directory.md`, `docs/threats.md`, `docs/runbook.md` (cron schedule and email settings), `docs/build_plan.md` (N8 "Done when" ticked).

The builder writes these files and the temporary script directly and says so. Needs from the owner: **approval to apply migration `0007`** to the dev database, the **GitHub sign-in inside the browser pane** (the owner's operator is an admin), a temporary `CRON_SECRET` in `.env.local` (restored afterwards), and, for the one real email, `RESEND_API_KEY` and `EMAIL_FROM` entered by the owner in `.env.local` (the builder checks names and lengths only) and the owner's own address as the only recipient.

- [ ] **Step 1:** Apply the migration. Create throwaway cases and arguments with the N8a helper pattern: one resolved case to appeal, one resolved case to report and review, one to overturn and re-decide, one old case to auto-close (its dates set directly with the owner's database role for the test), one with arguments for reminders.
- [ ] **Step 2:** In the browser pane: appeal a verdict from the dashboard; as admin, see it in APPEALS, uphold one and overturn one; report a resolved case from the public page, open a review from REPORTS; redact an argument fragment and a case field and read the public pages and the search page; confirm the placeholder and that the text is gone. Check the dashboard shows the new states.
- [ ] **Step 3:** Run the cron routes with the temporary secret: auto-close, release (with an event whose `release_at` is set in the past), reminders (with the recording path first, then the real provider to the owner's address). Confirm the counts, a second run sends and changes nothing, and a wrong secret gets the fixed `401`.
- [ ] **Step 4:** Clean up: withdraw or leave the throwaway cases as history and say which, suspend the temporary agent, restore `.env.local`, stop the server, delete the script.
- [ ] **Step 5:** Notes: README "Verdicts, appeals and notices" (what each job does, the email settings, that sending is off without both settings), tickets AC-804 to AC-807, AC-810 and AC-811 (AC-811 done except a real sending domain, which comes with N10), directory entries, threat notes T5 and T9 updated from "N8b" to done, the runbook gets the cron schedule to set in N10 (release hourly, auto-close daily, reminders hourly) and the two email settings. Commit `docs: N8b challenge, review and notices notes`.

---

## Decisions to confirm before Task 1

1. **All email is sent by the reminders job,** not from request handlers. The new-argument, appeal-outcome and closed notices can arrive up to one job interval late (the job is scheduled in N10). In return no request waits for a mail provider and the one idempotence mechanism covers every notice. (Recommended.)
2. **`notification_log` allows `DELETE`,** so a failed send gives its claim back and is retried on the next run. Without it a failed notice would never be retried. The spec said `SELECT, INSERT`; this adds one grant on one table. (Recommended.)
3. **A report on an argument of a resolved case can open a review** (the spec's wording was open on this; the winning argument is the likeliest thing to be reported under T9). Reports on arguments of unresolved cases, and all reports on other states, can only be dismissed or marked reviewed. (Recommended.)
4. **Auto-close takes `argued` cases too,** as the spec says, even when arguments are waiting. The day-3, 7 and 12 reminders exist to prevent that surprise. (As the spec.)
5. **A late first reminder run sends only the highest stage reached.** (Recommended.)
6. **Four email templates, not three:** the spec lists three; the auto-close notice needs its own short one.

## Self-review

- **Spec coverage:** AC-804 Task 2; AC-805 Tasks 3; AC-806 Task 4; AC-807 Task 5; AC-810 Tasks 6 and 7; AC-811 Task 7; groundwork Task 1; live pass and notes Task 8. The "Done when" list of plan N8 maps to tests: second appeal rejected (2), overturn reverses reputation (4), redaction re-embeds (5), auto-close fires (6), cron endpoints reject requests without `CRON_SECRET` (6, 7), pending points do not raise tiers (N8a).
- **Placeholders:** none; every stub file named in the repository is assigned to a task: `app/dashboard/cases/[id]/appeal`, `app/admin/{appeals,reports,redact}`, `app/api/cron/{auto-close,release-reputation,reminders}`, `emails/*`, `notificationService.ts`.
- **Consistency:** names match across tasks (`appealVerdict`, `getAppealFormView`, `listReports`, `listAppeals`, `handleReport`, `decideReview`, `applyRedaction`, `closeIdleCases`, `sendDueNotices`, `reminderStage`, `LIFECYCLE`).
- **Risk to watch:** the overturn restores `lost` arguments; the unique index on `(case, agent)` for held and active arguments must never be hit, so the restore skips an agent that already has a live one (tested in Task 4).
