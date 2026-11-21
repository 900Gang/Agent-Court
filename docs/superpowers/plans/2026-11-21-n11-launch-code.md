# N11 (code part) — Invites, Secret-scanning Endpoint and Public Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** for each task the builder writes the tests, confirms they fail ("red"), then writes the implementation; the owner says "check" or "continue"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm check:routes` and fixes anything; the owner commits and pushes. The builder writes docs, scripts and small config edits directly and says so. Outward actions (migrations on the owner's databases, deploys, real emails, anything sent to GitHub) happen only on the owner's explicit word. Secrets are never typed into chat.

**Goal:** The court can open to a first group: only invited GitHub accounts become operators, a leaked key is revoked within seconds of GitHub reporting it, and a newcomer can read what the court is and file a case from the quickstart in ten minutes.

**Architecture:** `operator_invites` (migration 0011) and `inviteService` feed one rule in `recordGithubLogin`: active needs the trust floor and, when `INVITE_ONLY` is on, an invite. `/admin/invites` adds and removes invites, looking a GitHub login up once through an injectable lookup. `lib/github/secretScanning.ts` (pure: key fetch with cache, signature check, token match) and `leakedKeyService` (revoke, audit, notify once) sit behind a thin route `POST /api/webhooks/github-secret-scanning`. The landing page, `/docs` and `docs/api.md` are static text whose samples are tested against the API's own constants. `app/robots.ts` records the indexing decision.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Zod, Vitest with PGlite, `node:crypto` for ECDSA. No new packages.

**Spec:** [`docs/superpowers/specs/2026-11-21-n11-launch-code-design.md`](../specs/2026-11-21-n11-launch-code-design.md) (owner decisions confirmed 2026-11-21), [`docs/build_plan.md`](../../build_plan.md) node N11, tickets AC-1102, AC-1103, AC-1106, AC-1107, AC-1109, [`docs/secret-scanning-application.md`](../../secret-scanning-application.md).

## Global Constraints

- All N1 to N10 rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, secret or request body in any log, email or error; error text fixed per code; `check:routes` stays green).
- **Invite-only is decided in one place**, `recordGithubLogin`, and never downgrades an operator who is already active.
- **The endpoint does nothing before the signature is verified.** Every refusal is a fixed answer with no side effect and no database work for the 401. The token is never stored, logged, emailed or echoed; the reported `url` is not stored or shown.
- **Counts and fixed words** in every log line, audit metadata, notice and response.
- **No guessing at GitHub.** A key that is not in our format, or not found by hash, changes nothing.
- **Nothing outward without the owner:** no migration on the owner's database, no email to GitHub, no real lookup against GitHub in tests (the lookup and the key fetch are injected).
- Constants live in `lib/config/constants.ts` (`INVITES`, `SECRET_SCANNING`).
- Next.js 16 and `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing route, page or `robots` code.
- No new packages.

## Review Focus

1. A not-invited operator can do nothing an active operator can; an invited one can; an active one is never locked out. Task 1.
2. Every way a webhook request can be wrong leaves keys, audit and mail untouched. Task 2.
3. The samples in the quickstart are the ones the API accepts. Task 3.

---

## Task 1: Invite allowlist (AC-1107)

**Files:** Create `db/schema/operatorInvites.ts`, migration `0011_n11_invites.sql`, `lib/services/inviteService.ts`, `lib/github/lookup.ts`, `lib/admin/inviteCore.ts`, `lib/admin/inviteData.ts`, `app/admin/invites/page.tsx`, `components/admin/InviteForms.tsx`; Modify `lib/config/env.ts` (`INVITE_ONLY`), `.env.example`, `lib/config/constants.ts` (`INVITES`), `lib/services/operatorService.ts` (`recordGithubLogin`, `promoteToAdmin`), `lib/auth/betterAuth.ts` (pass the setting), `lib/services/auditService.ts` (`invite.added`, `invite.removed`), `app/admin/actions.ts`, `components/admin/AdminSidebar.tsx`, `components/dashboard/PendingNotice.tsx`, `app/dashboard/layout.tsx`, `scripts/check-routes-gated.ts` (rule 10: only `inviteService` names `operator_invites`).
Tests: `tests/unit/envInvite.test.ts`, `tests/unit/githubLookup.test.ts`, `tests/integration/inviteService.test.ts`, `tests/integration/operatorInvite.test.ts`, `tests/integration/adminInvite.test.ts`, `tests/unit/adminInvitePage.test.tsx`, `tests/unit/pendingNotice.test.tsx`, `tests/unit/checkRoutesInvites.test.ts`.

- [ ] **Step 1: tests (red).** Env: `INVITE_ONLY` on or off, required in production and staging, off by default elsewhere, a typo stops the app. Lookup: a valid login returns id and login, invalid logins are refused before anything is sent, a non-user, a 404, a timeout and bad JSON are fixed errors. Service: add (resolves through the injected lookup), repeat is a no-op, the 500 limit, remove, list with each person's status. `recordGithubLogin`: with the setting off nothing changes; on, a new operator without an invite is pending and with one is active (if the trust floor passes); a pending operator invited later becomes active at the next sign-in; an active operator is never made pending; a not-invited operator cannot register an agent or issue a key. `promoteToAdmin` activates a pending operator and never a suspended one. Admin core: origin, then admin, then input; audit rows hold ids and logins only. Page: admin only, plain text. Pending notice: INVITE ONLY text versus vetting text.
- [ ] **Step 2: implementation.**
- [ ] **Step 3: owner applies migration 0011** to the development database on request (the builder asks first).
- [ ] **Step 4: Commit** `feat: N11 invite-only access with an admin allowlist`.

## Task 2: Secret-scanning alert endpoint (AC-1109)

**Files:** Create `lib/github/secretScanning.ts`, `lib/services/leakedKeyService.ts`, `lib/http/handlers/secretScanning.ts`, `app/api/webhooks/github-secret-scanning/route.ts`, `emails/keyLeaked.ts`; Modify `lib/config/constants.ts` (`SECRET_SCANNING`), `lib/services/auditService.ts` (`key.leaked`), `lib/services/notificationService.ts` (notice kind `key_leaked` if the shared claim is reused), `docs/secret-scanning-application.md` (status), `lib/services/keyService.ts` only if a hash helper must be exported.
Tests: `tests/unit/secretScanning.test.ts`, `tests/integration/leakedKeyService.test.ts`, `tests/integration/secretScanningRoute.test.ts`, `tests/unit/keyLeakedEmail.test.ts`.

- [ ] **Step 1: tests (red).** Pure: the token match is exact (prefix, 32 base62 characters, boundaries); the signature check passes for a body signed with a generated P-256 key and fails for a changed byte, a different key, a different identifier, a truncated or non-base64 signature, an empty one; the key fetch is cached for an hour, refetches once for an unknown identifier, at most once a minute, and survives a failing fetch. Service: a live key is revoked once with one `key.leaked` audit row and one email; a second report changes and sends nothing; revoked, expired and unknown keys are counted and change nothing; a token in a different format is ignored; the audit row and the email hold no token and no URL. Route: every refusal (wrong method, no headers, bad signature, unknown identifier, key fetch failing, body too big, not JSON, not an array, too many items, a bad item) is the fixed answer and changes nothing; a good request answers 200 with counts only; nothing from the body reaches the log.
- [ ] **Step 2: implementation.**
- [ ] **Step 3: Commit** `feat: N11 GitHub secret-scanning alert endpoint`.

## Task 3: Public pages and the indexing decision (AC-1102, AC-1103, AC-1106)

**Files:** Create `app/(public)/docs/page.tsx`, `lib/docs/quickstart.ts` (the samples as data), `docs/api.md`, `app/robots.ts`; Modify `app/(public)/page.tsx`, `components/PublicShell.tsx` (a DOCS link), `docs/build_plan.md` (the AC-1106 decision).
Tests: `tests/unit/quickstart.test.ts`, `tests/unit/landingPage.test.tsx`, `tests/unit/docsPage.test.tsx`, `tests/unit/robots.test.ts`, the existing root metadata test.

- [ ] **Step 1: tests (red).** The quickstart samples use only paths, methods, headers, scopes and field names that the API's own schemas and route files define (read from the same constants, so a rename breaks the test); the page and `docs/api.md` carry the same samples; the landing page names the six steps, links to the quickstart and the sources page, and says that operators join by invitation; `robots.txt` disallows the five prefixes, lists no sitemap, and every page keeps `noindex`.
- [ ] **Step 2: implementation.**
- [ ] **Step 3: Commit** `feat: N11 landing page, quickstart and robots decision`.

## Task 4: Notes and the launch steps

**Files:** Modify `README.md`, `docs/ticket.md`, `docs/directory.md`, `docs/threats.md` (T5 or T6 and the key-leak note), `docs/runbook.md` (invite-only, the webhook check after enrolment, the second admin, the domain). The builder writes them directly.

- [ ] **Step 1:** README "Opening the court" (invite-only, the endpoint); tickets AC-1102, AC-1103, AC-1106, AC-1107, AC-1109 with real status and the owner's remaining ones named; directory rows; threats notes; runbook steps with Records lines.
- [ ] **Step 2: Commit** `docs: N11 notes`.

---

## Self-review

- **Spec coverage:** AC-1107 Task 1; AC-1109 Task 2; AC-1102, AC-1103, AC-1106 Task 3. Not in this plan, on purpose: AC-1101 (domain), AC-1104 and AC-1105 (terms, privacy, takedown: written next), AC-1108 (second admin), AC-1110 (send the application, after AC-1109 is live).
- **Placeholders:** none. Migration `0011` follows `0010`.
- **Consistency:** names used across tasks: `operator_invites`, `inviteService`, `INVITE_ONLY`, `INVITES`, `SECRET_SCANNING`, `leakedKeyService`, `key.leaked`, `/admin/invites`, `/docs`, `/api/webhooks/github-secret-scanning`.
- **Risk to watch:** Task 2 is public and unauthenticated by design: the signature check is its only gate, and the tests attack it hardest. Task 1's rule must live in one place.
- **Owner time:** Task 1 needs "apply migration"; the real GitHub enrolment, the domain, terms and privacy review, and the second admin are the owner's and come after.
