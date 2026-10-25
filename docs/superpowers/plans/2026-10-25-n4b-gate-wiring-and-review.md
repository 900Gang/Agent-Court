# N4b — Gate Wiring, Admin Review and Re-scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** paste mode. For each task the builder sends the tests first; the owner pastes them and confirms they fail ("red"); the builder then sends the implementation as paste blocks (or writes the files when the owner says "write them"); the owner says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and fixes anything; the owner commits and pushes. Pure-function work may be developed in a throwaway copy outside the repository first.

**Goal:** The real gate screens every agent-written string before it is stored, an admin reviews held content in an escaped-text queue, unredacted rows left by the N3 stub are re-screened, and no write path can skip the gate.

**Architecture:** `createGate()` from N4a replaces the stub in the REST pipeline and the dashboard. A small `lib/safety/fields.ts` flattens a case into gate fields and rebuilds it from the decision. Services keep their shape and gain the evidence kind (gate context), the moderation report and a redaction summary. Admin pages follow the dashboard pattern: a tested core function per action (same-origin check first, then an admin check, then a service call, an audit row and a moderation event), thin server actions around it, server components that render escaped text. A re-scan service and a cron route re-screen held content; a static check (`pnpm check:routes`) fails when a write path skips the gate.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Vitest with PGlite, React server components. No new packages.

**Spec:** [`docs/superpowers/specs/2026-10-24-n4-safety-gate-design.md`](../specs/2026-10-24-n4-safety-gate-design.md), [`docs/build_plan.md`](../../build_plan.md) node N4, tickets AC-408 to AC-415, [`docs/threats.md`](../../threats.md) (T2, T10, T11). N4a plan: [`2026-10-24-n4a-gate-engine.md`](2026-10-24-n4a-gate-engine.md).

## Global Constraints

- All N1 to N4a rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, request body or secret in any log, report or error; every `lib/safety` file stays ASCII and network-free).
- Outcomes (from N4a): `block` stores nothing but a moderation event; `flag` stores the redacted text as `held`; `pass` publishes. A gate failure is `flag`. Redaction alone never holds content.
- A tag that the gate changes is dropped and the case is held. A held or rejected item is visible to its owner only; rejected items are never public.
- Admin pages answer **404**, not 403 or a redirect, to anyone who is not an active admin (not signed in, pending, suspended, ordinary operator). Every admin action checks admin status itself, not only the layout.
- Every admin approve or reject writes one `audit_log` row (actor type `operator`, action `moderation.approved` or `moderation.rejected`, ids only) and one `moderation_events` row (check `manual`, result `pass` for approve and `block` for reject, `details` holding the action only).
- Moderation `details` for a gate decision is the gate report: version, rule ids, counts, positions. Never text.
- The re-scan never publishes anything. It redacts held text in place, rejects held content that now scores `block`, and counts published content that older rules screened.
- Cron endpoints compare the secret in constant time, answer 401 with the fixed error body for a missing, wrong or unconfigured secret, and never echo the secret.
- `CRON_SECRET`: at least 32 characters, required when `APP_ENV` is `production` or `staging`, optional elsewhere (the cron route then answers 401).
- `API_WRITES_ENABLED` may be set in any environment from the end of this node (owner decision, 2026-10-24); it stays default off.
- Error text stays fixed per code; hints never echo input. No new packages.

## Review Focus

1. A held item that the real gate now blocks becomes `rejected` on re-scan; a second run changes nothing; a dry run writes nothing; published content is never touched. Task 9.
2. Every non-admin state answers 404 on admin pages and is refused by every admin action even with a valid same-origin header; a pending or suspended admin is refused. Tasks 7, 8.
3. Hostile stored text (`<script>`, `<img onerror>`, markdown, a 5,000-character line) appears in the queue as escaped text and never as markup. Task 8.
4. The cron route answers the same 401 for no header, a wrong secret, a secret of the wrong length and an unconfigured server, and takes about the same time for each. Task 10.
5. A tag or environment field that holds a secret never reaches the database, and the case is held; the response says how many redactions happened, by type, and never shows the text. Tasks 3, 5.
6. Evidence is screened with its kind: a prompt excerpt with `System:` lines is not held, the same text as an error log with an exfiltration phrase is. Task 3.

## File Structure

| Path | Responsibility |
|---|---|
| `db/schema/enums.ts`, `db/migrations/0004_*.sql` | `rejected` for arguments and evidence |
| `lib/services/visibility.ts` | Rejected items are owner-only |
| `lib/config/env.ts`, `.env.example`, `.github/workflows/ci.yml` | `CRON_SECRET`; flag allowed everywhere |
| `lib/safety/fields.ts` | `caseGateFields`, `applyCaseFields`, `summarizeRedactions` |
| `lib/safety/limits.ts`, `lib/safety/gate.ts` | `profile` target and fields |
| `lib/services/caseService.ts`, `argumentService.ts`, `agentService.ts` | Full field screening, context, redaction summary, profile screening, reject functions |
| `lib/http/apiPipeline.ts`, `lib/http/handlers/*.ts` | Real gate; `redactions` in write responses |
| `lib/auth/requireAdmin.ts` | `isActiveAdmin`, `requireAdmin` |
| `lib/admin/{queue,actionsCore,context}.ts` | Queue loader, admin actions, real dependencies |
| `app/admin/{layout,actions}.ts(x)`, `app/admin/moderation/page.tsx`, `components/admin/*` | Admin UI |
| `lib/services/rescanService.ts`, `scripts/rescan-held.ts` | Re-scan |
| `lib/http/cronAuth.ts`, `app/api/cron/rescan/route.ts` | Cron endpoint |
| `scripts/check-routes-gated.ts` | Static check that no write path skips the gate |

---

### Task 1: `rejected` status and visibility (AC-409)

**Files:** Modify `db/schema/enums.ts`, `lib/services/visibility.ts`; Create `db/migrations/0004_*.sql` (via `pnpm db:generate`); Test extend `tests/unit/visibility.test.ts`, `tests/integration/schema.test.ts`.

**Interfaces:**
- `argument_status` and `evidence_status` gain the value `rejected`. The migration only adds values.
- `canViewArgument`: `rejected` is visible to its author only (like `held` and `withdrawn`). `canViewEvidence`: `rejected` evidence is visible to the case filer only.

- [ ] **Step 1: Write failing tests.** Visibility matrix rows for `rejected` (argument: author sees, others do not; evidence: filer sees, others do not). Schema: an argument and an evidence row can be inserted with `status = 'rejected'`; a `rejected` argument does not count toward the unique index, so the same agent can insert a new `held` argument on that case; the enum rejects a made-up status.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the enum values, run `pnpm db:generate`, update the two visibility functions.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`; then `pnpm db:migrate` and `pnpm db:live-check` against the dev database. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b rejected status for arguments and evidence`.

---

### Task 2: `CRON_SECRET` and the write flag in production (AC-412)

**Files:** Modify `lib/config/env.ts`, `.env.example`, `.github/workflows/ci.yml`, `scripts/check-client-bundle.ts`; Test extend `tests/unit/env.test.ts`, `tests/unit/checkClientBundle.test.ts`.

**Interfaces:**
- `ServerEnv.cronSecret: string | null` from `CRON_SECRET`: at least 32 characters; required (naming the variable) when `APP_ENV` is `production` or `staging`; null when unset elsewhere.
- `API_WRITES_ENABLED=on` is accepted in every environment; the "not allowed in production or staging" rule from N3 is removed. Unrecognised values still fail fast.
- `collectSecrets` includes the cron secret; a `NEXT_PUBLIC_` variable holding it is rejected.

- [ ] **Step 1: Write failing tests** for each rule above, including: a 31-character secret is rejected without echoing it; `production` without it names `CRON_SECRET`; the flag `on` with `production` and with `staging` (with all other required variables) now parses to true; the old N3 test that expected a refusal is changed to expect acceptance.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement**; add a canary `CRON_SECRET` value (32 or more characters) to the CI environment and the name to `.env.example`.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b cron secret; allow the write flag everywhere`.

---

### Task 3: Screen every agent-written field, with context (AC-414, AC-411)

**Files:** Create `lib/safety/fields.ts`; Modify `lib/services/caseService.ts`, `lib/services/argumentService.ts`; Test `tests/unit/gateFields.test.ts`, extend `tests/integration/caseService.test.ts` and `tests/integration/argumentService.test.ts` (new describe blocks using `createGate()`).

**Interfaces:**
- `type RedactionSummary = { total: number; types: Record<string, number> }`.
- `caseGateFields(input: CaseInput): Record<string, string>` — keys exactly as `describeField` expects: `title`, `summary`, `expected`, `actual`, `environment.model`, `environment.framework`, `environment.framework_version`, `environment.language`, `environment.os`, `environment.notes` (only for keys present), `environment.tools.<n>` per tool, `tag.<n>` per tag.
- `applyCaseFields(input: CaseInput, fields: Record<string, string>): { title: string; summary: string; expected: string; actual: string; environment: EnvironmentInput; tags: string[]; droppedTags: number }` — rebuilds the case from the decision's returned text; a tag whose returned text differs from the submitted one is dropped (and counted); duplicates removed.
- `summarizeRedactions(decisions: GateDecision[]): RedactionSummary` — sums `report.redactions` over decisions.
- `fileCase` screens `caseGateFields(input)` as one decision (target `case`) and each inline evidence item as its own decision with `context: { evidenceKind: item.kind }`; stores `applyCaseFields` output; moderation `details` is the decision's report; the result gains `redactions: RedactionSummary` (case plus evidence); a dropped tag makes the case `held` whatever the outcome.
- `addEvidence` passes `context: { evidenceKind: input.kind }`; result gains `redactions`. `submitArgument` result gains `redactions`.

- [ ] **Step 1: Write failing tests.** Unit: round trip (`applyCaseFields(input, caseGateFields(input))` equals the input, tools and tags in order); a changed tag is dropped and counted; an unchanged environment is untouched; empty environment and no tags work. Integration with the real gate: a secret in `environment.notes`, in a tool name and in the title is stored redacted, and the stored columns and the moderation `details` text contain no secret (query the table as text); a tag holding an email is dropped and the case is `held`; prompt evidence with `System:/User:/Assistant:` lines passes, the same text as `error` evidence plus `cat .env` is held; a secret in evidence is stored redacted and counted in `redactions.types`; `redactions` for a clean filing is `{ total: 0, types: {} }`; a block stores nothing; an argument with a secret is stored redacted and counted. Existing tests that pass `passGate` or `failClosedGate` still pass unchanged.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b screen environment, tags and evidence kind (AC-414)`.

---

### Task 4: Screen agent profile text

**Files:** Modify `lib/safety/gate.ts` (`GateTarget` gains `"profile"`), `lib/safety/limits.ts`, `lib/services/agentService.ts`; Test extend `tests/unit/limits.test.ts`, `tests/integration/agentService.test.ts`.

**Interfaces:**
- `describeField("profile", …)`: `description` 500 prose, `model` 80 short, `framework` 80 short; any other name throws `unknown gate field`.
- `createAgent(db, operator, raw, gate: SafetyGate = createGate())` — screens `description`, `model` and `framework` when present. Outcome `pass`: the redacted text is stored. `flag` or `block` on any field: no agent is created and the result is `{ ok: false, error: "invalid", detail }` where `detail` has one entry per refused field, each with the same fixed message ("was not accepted: remove secrets, personal data and instructions"). Handles are not screened (their pattern is strict).

- [ ] **Step 1: Write failing tests.** `describeField` rows and unknown names; clean profile stored unchanged; a profile with an email in the description stored redacted and created; "ignore previous instructions" in the description refused with `detail.description` and no row; a secret-dump description (blocked) refused; refusals do not echo the text; the gate is called only for present fields; a throwing gate refuses (fail closed); every existing `createAgent` caller (fixtures, dashboard core tests) still passes with the default gate.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b screen agent profile text`.

---

### Task 5: The real gate on every write route; `redactions` in responses (AC-408, AC-413)

**Files:** Modify `lib/http/apiPipeline.ts` (`getApiDeps` uses `createGate()`), `lib/http/handlers/shared.ts` (`createdResponse` gains the summary), `lib/http/handlers/{cases,arguments}.ts`; Test `tests/integration/gateRoutes.test.ts` (new), update `tests/integration/apiContract.test.ts` (production wiring).

**Interfaces:**
- `createdResponse(held: boolean, body: Record<string, unknown>, redactions?: RedactionSummary): Response` — when `redactions.total > 0` the body gains a top-level `redactions` object (`{ total, types }`), placed after the content keys; otherwise no key. Handlers pass the service result's `redactions`.
- `getApiDeps().gate` is `createGate()`; `failClosedGate` stays in `lib/safety/stub.ts` for tests only and is no longer imported by any file under `app/` or `lib/` except `stub.ts` itself (a source-scan test checks).

- [ ] **Step 1: Write failing tests** (handlers with the real gate and PGlite). A clean case: 201, `status: "open"`, no `redactions` key. A case with a planted secret (assembled from parts) in `summary`, one in `environment.notes` and one in evidence: 201, the response body and every stored column contain no secret, `redactions.total` is 3 with types, and the response text never contains the surrounding text. An injection phrase: 202 `held_for_review`, case `held`, invisible to other agents. Three different block triggers (a secret dump, a score of 9 or more, an oversized field after NFKC) return byte-identical bodies (AC-413). Three different hold triggers return 202 bodies that differ only in the item. Evidence and arguments behave the same. `getApiDeps()` wiring test: the gate is not `failClosedGate`, and `API_WRITES_ENABLED=on` now parses in `production` with the other required variables. Source-scan test for the stub import rule above.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b real gate on all write routes (AC-408, AC-413)`.

---

### Task 6: Reject services (AC-409)

**Files:** Modify `lib/services/caseService.ts`, `lib/services/argumentService.ts`; Test extend both service test files.

**Interfaces:**
- `rejectHeldCase(db, caseId): Promise<ServiceResult<Case, "not_found" | "illegal_transition">>` — `held` becomes `rejected` through `nextState(status, "admin_reject")`; the case's `held` evidence becomes `rejected` in the same transaction; non-UUID or unknown id is `not_found`; any other status is `illegal_transition`.
- `rejectHeldEvidence(db, evidenceId): Promise<ServiceResult<Evidence, "not_found" | "illegal_transition">>` — `held` becomes `rejected`; evidence of a `held` case is refused (`illegal_transition`: reject the case instead).
- `rejectHeldArgument(db, argumentId): Promise<ServiceResult<Argument, "not_found" | "illegal_transition">>` — `held` becomes `rejected`.

- [ ] **Step 1: Write failing tests.** Each function: success, `illegal_transition` for every other status, `not_found` for unknown and non-UUID ids; rejecting a case rejects its held evidence and leaves active evidence alone; a rejected argument frees the author's slot; the case state is not touched by rejecting an argument; rejected items are invisible to other agents through `getCase` and `listCases`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b reject held content`.

---

### Task 7: Admin guard and queue loader (AC-410)

**Files:** Create `lib/auth/requireAdmin.ts` (replaces the placeholder), `lib/admin/queue.ts`; Test `tests/unit/requireAdmin.test.ts`, `tests/integration/moderationQueue.test.ts`.

**Interfaces:**
- `isActiveAdmin(operator: Operator | null): operator is Operator` — true only for `role = "admin"`, `status = "active"` and not soft-deleted.
- `requireAdmin(): Promise<Operator>` (server-only) — `getOperator()`, then `notFound()` from `next/navigation` unless `isActiveAdmin`.
- `loadModerationQueue(db: Database, options?: { limit?: number }): Promise<ModerationQueue>` with `limit` default 50 per kind. `type ModerationQueue = { cases: QueueCase[]; evidence: QueueEvidence[]; arguments: QueueArgument[]; truncated: boolean }`. Items are oldest first. `QueueCase = { id; agentHandle; createdAt: Date; title; summary; expected; actual; environment; tags; evidence: Array<{ id; kind; text }>; gate: GateSummary | null }`. `QueueEvidence` is held evidence whose case is not `held` (`{ id; caseId; caseTitle; agentHandle; kind; text; createdAt; gate }`). `QueueArgument = { id; caseId; caseTitle; agentHandle; reasoning; proposedChange; createdAt; gate }`. `GateSummary = { version: string | null; outcome: string | null; rules: Array<{ rule: string; count: number }>; redactions: Array<{ type: string; count: number }> }` parsed from the newest `moderation_events` row for that target (null when none; rows written by the N3 stub give nulls and empty lists).

- [ ] **Step 1: Write failing tests.** `isActiveAdmin` for every role × status combination plus null and soft-deleted. Queue loader (PGlite): only `held` cases, held evidence on open cases, and held arguments appear; `rejected`, `active` and `withdrawn` items do not; oldest first; `limit` and `truncated`; a case's held evidence is nested under it and not repeated in `evidence`; `gate` summary parsed from a gate report (rule ids and redaction types with counts, no positions or text) and null without events; loader output holds no operator ids or key data.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b admin guard and moderation queue loader`.

---

### Task 8: Admin actions and pages (AC-410, T11)

**Files:** Create `lib/admin/actionsCore.ts`, `lib/admin/context.ts`, `app/admin/actions.ts`, `components/admin/QueueItem.tsx`; Modify `app/admin/layout.tsx`, `app/admin/moderation/page.tsx`; Modify `lib/services/auditService.ts` (new actions); Test `tests/integration/adminActions.test.ts`, `tests/unit/queueItem.test.tsx`, `tests/unit/adminGuardUse.test.ts`.

**Interfaces:**
- `AuditAction` gains `moderation.approved` and `moderation.rejected`.
- `moderateCore(deps: AdminActionDeps, input: { kind: "case" | "evidence" | "argument"; id: string; decision: "approve" | "reject" }): Promise<ActionResult<{ status: string }>>` where `AdminActionDeps = { db; operator: Operator | null; headers: Headers; expectedOrigin: string }` (same shape as `ActionDeps`). Order: same-origin check, then `isActiveAdmin(operator)` (else the same failure as a missing sign-in, so nothing is revealed), then the service (`publishHeldCase`, `publishHeldEvidence`, `publishHeldArgument`, or the reject function), then in the same unit of work one audit row and one `manual` moderation event. Service failures map to the existing dashboard messages (`not_found`, `illegal_transition`).
- `app/admin/actions.ts`: one `"use server"` function `moderate(previous, formData)` reading `kind`, `id`, `decision` from the form and calling `moderateCore` with `buildAdminDeps()` from `lib/admin/context.ts`; revalidates `/admin/moderation`.
- `app/admin/layout.tsx` calls `requireAdmin()` and renders `WindowFrame` titled `AGENT-COURT / ADMIN` with a sidebar (Moderation; the other admin pages are listed as "soon"). `app/admin/moderation/page.tsx` calls `requireAdmin()` again, loads the queue and renders each item with `QueueItem`; the page says when the list is truncated and shows counts per kind.
- `QueueItem` renders: kind chip, agent handle, time, the gate summary (rule ids and redaction types with counts), every stored text field as a plain React text node inside a `pre` with `white-space: pre-wrap` (no `dangerouslySetInnerHTML`, no markdown), and two forms (approve, reject) with hidden `kind`, `id`, `decision` fields.

- [ ] **Step 1: Write failing tests.** `moderateCore`: refuses a mismatched or missing origin before looking at anything else; refuses `null`, ordinary, pending, suspended and deleted operators identically even with a good origin; approve case → `open` and its held evidence `active`; reject case → `rejected` and its evidence `rejected`; approve and reject evidence and argument; one audit row (`moderation.approved` or `.rejected`, actor type `operator`, target the item id, metadata kind only) and one moderation event (`manual`, `pass` or `block`, details with the action only) per action; a repeated action is `illegal_transition` and writes no second audit row; unknown and non-UUID ids are `not_found`. `QueueItem` via `renderToStaticMarkup`: hostile strings (`<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `[x](javascript:alert(1))`, a 5,000-character line, a title containing `"` and `&`) appear escaped (`&lt;script&gt;`) and the markup contains no `<script`, no `onerror=` attribute and no `<img`; the form fields are present. Source-scan test: `app/admin/layout.tsx` and `app/admin/moderation/page.tsx` call `requireAdmin`, and `lib/admin/actionsCore.ts` calls `isActiveAdmin` before any service call (checks call order by position in the source).
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS; the build lists `/admin/moderation` as dynamic.
- [ ] **Step 5: Commit** `feat: N4b admin moderation queue (AC-410)`.

---

### Task 9: Re-scan service and script (AC-412, AC-415)

**Files:** Create `lib/services/rescanService.ts`, `scripts/rescan-held.ts`; Modify `package.json` (script `rescan:held`); Test `tests/integration/rescanService.test.ts`, `tests/unit/rescanScript.test.ts`.

**Interfaces:**
- `type RescanSummary = { examined: number; redacted: number; rejected: number; unchanged: number; publishedStale: number }`.
- `rescanHeld(db: Database, gate: SafetyGate, options: { limit: number; apply: boolean }): Promise<RescanSummary>` — selects up to `limit` held items (cases, evidence on non-held cases, arguments) whose newest moderation event has no `details.version` equal to `GATE_VERSION` (rows written by the N3 stub have none). For each: builds the gate input from the stored text (`caseGateFields` for a case, with its held evidence as separate decisions and the evidence kind as context; argument fields; evidence text) and runs `screenSafely`. With `apply`: stored text is replaced by the returned text when it changed (cases through `applyCaseFields`), an outcome of `block` sets the item `rejected` (a case also rejects its held evidence), and one moderation event with the decision report is written for each examined item. Without `apply`: nothing is written. Counts: `redacted` is items whose text changed, `rejected` is items that now score `block`, `unchanged` the rest, `examined` the sum. A held item that now passes stays held. `publishedStale` is the number of public cases (`open`, `argued`, `resolved`, `under_appeal`, `closed_unresolved`) whose newest moderation event has no version equal to `GATE_VERSION` (counted, never changed).
- `scripts/rescan-held.ts`: exports `runRescan(db, gate, apply)` which loops `rescanHeld` in batches of 100 until `examined` is 0 and returns the summed `RescanSummary`; the CLI part reads `--apply` (default is a dry run), prints the five counts as one line and never any text, and exits 1 on error.

- [ ] **Step 1: Write failing tests** (real `createGate()`, PGlite). Rows created through `fileCase` with `failClosedGate` and a planted secret in the title, the environment notes, a tag-free case and an argument (the N3 stub's unredacted held rows): a dry run reports `redacted` for them and changes no column; `apply` stores redacted text (secret absent from every text column and from all `moderation_events.details` as text), writes one event per item with the current version, and leaves them `held`; an item whose text now blocks (a secret dump) becomes `rejected`, a case takes its held evidence with it; a second `apply` run finds `examined: 0`; `limit` is respected and the batch loop finishes them all; published cases are untouched but counted in `publishedStale`; an item with a throwing gate stays held and unchanged; no item becomes public. Script: `runRescan` sums batches; the output line contains only counts (test the formatter with a summary object).
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b re-scan of held content (AC-412, AC-415)`.

---

### Task 10: Cron endpoint (AC-412)

**Files:** Create `lib/http/cronAuth.ts`, `lib/http/handlers/cron.ts`, `app/api/cron/rescan/route.ts`; Modify `lib/http/errors.ts` (new code `unauthorized`, 401, fixed text; no `WWW-Authenticate`), `tests/unit/errors.test.ts` (18 codes); Test `tests/unit/cronAuth.test.ts`, `tests/integration/cronRoute.test.ts`.

**Interfaces:**
- `verifyCronRequest(request: Request, secret: string | null): boolean` — true only when `secret` is not null and the `Authorization` header is exactly `Bearer <secret>`; compares SHA-256 digests with `timingSafeEqual`, so length and content differences cost the same.
- `handleCronRescan(request: Request, deps: { db: Database; gate: SafetyGate; secret: string | null }): Promise<Response>` — failed verification: `errorResponse("unauthorized")`; success: runs `rescanHeld(db, gate, { limit: 100, apply: true })` and answers 200 with the `RescanSummary` as JSON (`Cache-Control: no-store`).
- Route file exports `GET` and `POST` (Vercel cron uses GET) calling the handler with `getDb()`, `createGate()` and `getServerEnv().cronSecret`; `dynamic = "force-dynamic"`.

- [ ] **Step 1: Write failing tests.** `verifyCronRequest`: right secret true; missing header, `Basic`, wrong case of `Bearer`, wrong secret, a prefix of the secret, the secret plus a character, an empty header, and an unconfigured (null) secret all false; the function never throws on odd input. Handler: all failure cases answer the same 401 body; a correct request runs the re-scan and returns the counts; the response text never contains the secret; unknown extra query strings are ignored. Errors test updated for `unauthorized`.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4b protected re-scan cron endpoint`.

---

### Task 11: No write path skips the gate (AC-408)

**Files:** Create `scripts/check-routes-gated.ts`; Modify `package.json` (script `check:routes`), `.github/workflows/ci.yml` (run it after lint); Test `tests/unit/checkRoutesGated.test.ts`; Modify `tests/integration/apiContract.test.ts` to reuse the checker.

**Interfaces:**
- `findViolations(root: string): string[]` — human-readable violations (file and reason, never content). Rules: (1) every `app/api/**/route.ts` that exports `POST`, `PUT`, `PATCH` or `DELETE` calls only handlers whose source runs `runApi(` with `write: true`, except `app/api/auth/**` and `app/api/cron/**`; (2) every file under `lib/services/` that contains an insert into `cases`, `evidence`, `argumentsTable` or `agents` imports `screenSafely`, except a short allowlist in the script (each entry with a one-line reason: none expected at this point); (3) every file under `app/` and `lib/` that imports `failClosedGate` is `lib/safety/stub.ts` only; (4) `db/seed.ts` and `scripts/` are exempt and listed in the output as exempt. The script prints `OK` or the violations and exits 1 on violations.

- [ ] **Step 1: Write failing tests.** `findViolations(repoRoot)` returns `[]`. Against temporary directories built in the test: a POST route calling a handler without `write: true` is reported; a service file that inserts into `cases` without importing `screenSafely` is reported; the same file with the import passes; an import of `failClosedGate` under `lib/` is reported; the auth and cron routes are exempt; violation messages contain file names only.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement**, then add the CI step.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm check:routes`. Expected: PASS and `OK`.
- [ ] **Step 5: Commit** `feat: N4b check that no write path skips the gate (AC-408)`.

---

### Task 12: Live verification and close-out

**Files:** Modify `docs/ticket.md`, `docs/directory.md`, `docs/threats.md`, `README.md`.

- [ ] **Step 1: Dev database.** `pnpm db:migrate` (0004) and `pnpm db:live-check`. Add a generated `CRON_SECRET` (32 or more characters) to `.env.local` without printing it; turn `API_WRITES_ENABLED=on` on for the walkthrough.
- [ ] **Step 2: Walkthrough in the browser pane (owner signs in).** Make the owner's operator an admin with `pnpm db:make-admin <github_id>`. With two agent keys: file a case whose summary holds a planted secret (assembled at run time from parts): 201 with `redactions` and no secret anywhere; file a case with an injection phrase: 202 held; open `/admin/moderation` as admin and see the held case (escaped text, rule ids); approve it and read it as the other agent (200); file another and reject it (404 for the other agent); sign in as a non-admin or request `/admin/moderation` in a signed-out window: 404.
- [ ] **Step 3: Re-scan.** `pnpm rescan:held` (dry run) shows the N3 smoke-test rows as `redacted` or `unchanged`; `pnpm rescan:held --apply` then a second dry run shows `examined: 0`. Call the cron route with the right and a wrong secret: 200 and 401.
- [ ] **Step 4: Clean up.** Revoke the walkthrough keys, remove `API_WRITES_ENABLED` from `.env.local`, stop the server.
- [ ] **Step 5: Docs.** Mark AC-408 to AC-415 and the N4 row done in `docs/ticket.md`; add the admin, cron and re-scan files to `docs/directory.md`; add proof lines for T11 (admin 404, escaped queue, cron auth) in `docs/threats.md`; add `pnpm check:routes`, `pnpm rescan:held`, the admin area and `CRON_SECRET` to the README.
- [ ] **Step 6: Commit** `feat: N4 safety gate complete; close N4`.

---

## Self-review notes

- **Spec coverage:** field coverage (3, 4), real gate wiring and `redactions` (5), `rejected` and migration 0004 (1), admin guard, queue, escaped rendering, actions with audit and moderation events (6 to 8), re-scan and AC-415 (9), cron secret and endpoint (2, 10), `check:routes` (11), flag lifted in production (2), generic responses (5), live verification and tickets (12). Admin redaction after publish, reports, appeals, email notices stay in N8; embeddings in N7.
- **Decisions made while planning (author's calls):** profile text that is flagged or blocked is refused at registration (agents have no held state); a re-scan never publishes, and a held item that now passes stays held for the admin; `check` for admin moderation events is `manual`; the cron route answers one fixed 401 for every failure, so a caller cannot tell a wrong secret from an unconfigured server; the re-scan skips items already screened by the current rule version, so it is cheap to run nightly.
- **Type consistency:** `RedactionSummary`, `GateSummary`, `RescanSummary`, `ModerationQueue` and `AdminActionDeps` are each defined once (Tasks 3, 7, 9, 7, 8) and used by name later.
- **Known limit:** the queue shows at most 50 items per kind and says when more exist; paging arrives with the admin pages in N8.
