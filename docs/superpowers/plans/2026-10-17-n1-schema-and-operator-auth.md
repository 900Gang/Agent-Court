# N1 — Schema and Operator Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision note (2026-10-18):** rewritten for Neon (D1) and Better Auth (D12). The earlier Supabase version is obsolete.

**Goal:** A fresh clone runs `pnpm db:migrate && pnpm dev`; a GitHub login creates an `operators` row; the database is locked down so only the `app_server` role can read or write; CI is green.

**Architecture:** Next.js App Router app; Drizzle owns schema and migrations; the app reaches Postgres only from server code, as the least-privilege `app_server` role over Neon's pooled endpoint. Better Auth (GitHub provider, Drizzle adapter) handles operator login; its tables live in our database. Database behaviour (constraints, RLS, grants) is proven against an in-process Postgres (PGlite + pgvector), then re-checked live against the Neon dev database.

**Tech Stack:** Next.js (latest stable), TypeScript strict, pnpm, Drizzle ORM + drizzle-kit, `postgres` driver, `better-auth`, `@electric-sql/pglite` (tests), Zod, Vitest, ESLint, GitHub Actions.

**Spec:** [`docs/spec.md`](../../spec.md), [`docs/build_plan.md`](../../build_plan.md) (Sections 4.1, 4.2, 5, node N1, D1, D12), [`docs/threats.md`](../../threats.md) (T7, T10), tickets AC-101 to AC-110 in [`docs/ticket.md`](../../ticket.md).

## Global Constraints

- Package manager is `pnpm`; TypeScript `strict: true`; path alias `@/` maps to the repo root.
- Only `lib/config/env.ts` reads `process.env` (ESLint rule).
- Routes and components never import `db/`; only services and `lib/auth` do.
- RLS is enabled **and forced** on every table in `public`. `PUBLIC` has no table grants. The only policies belong to `app_server`. No Data API or HTTP-to-database interface is enabled.
- `DATABASE_URL`, `DATABASE_URL_DIRECT`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_SECRET` are server-only: never `NEXT_PUBLIC_`, never logged, never in client bundles.
- Raw request bodies, headers and keys are never logged.
- Operator trust floor: GitHub account at least 30 days old and a verified email, otherwise `status = 'pending'`. `role = 'admin'` is set manually in the database, never by code.
- GitHub provider tokens are never stored: both account hooks null them before the row is written. Account age comes from the GitHub profile Better Auth already fetches (`created_at`).
- `audit_log` and `moderation_events` are append-only for the app role (no UPDATE, no DELETE).
- `verdicts` allows one live verdict per case: unique on `case_id` where `status <> 'overturned'`.
- An argument with status `won` cannot move to `withdrawn` (DB trigger).
- `case_embeddings` and `search_events` belong to N7: their files stay empty `export {}` stubs.
- Never commit a real secret. `.env.example` lists names only.

## Review Focus

Behaviours the spec implies that no ticket's acceptance test names:

1. GitHub profile has no or an unparseable `created_at`: operator stays `pending`, login still succeeds, nothing throws. Task 6.
2. A `suspended` operator logs in again: status and `role` unchanged. A `pending` operator whose account has now aged past 30 days becomes `active`. Task 6.
3. Provider tokens are never stored: both account hooks strip them. Task 6.
4. A second non-overturned verdict for one case is rejected; after the first is `overturned`, a new one is accepted. Task 3.
5. Logger given a circular object, an `Error`, a `Bearer ...` string and a nested key named `authorization` never throws and never emits the secret. Task 2.
6. Missing or malformed env in production fails fast naming the variable (not its value); a `NEXT_PUBLIC_*` variable equal to a server secret is rejected. Task 2.
7. `app_server` cannot UPDATE or DELETE `audit_log` or `moderation_events`; a role with no grants sees nothing in any table, including Better Auth's tables. Task 4.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts` | Tooling |
| `app/layout.tsx`, `app/(public)/page.tsx` | Minimal shell so `pnpm dev` serves a page |
| `lib/config/env.ts`, `lib/config/logger.ts` | Validated env; scrubbing logger |
| `db/schema/*.ts` | One Drizzle table file per area (`auth.ts` for Better Auth tables), `index.ts` re-exports |
| `db/migrations/0000_*.sql` | Drizzle-generated tables, extension, enums |
| `db/migrations/0001_security.sql` | Hand-written: role, RLS, revokes, grants, policies, triggers |
| `db/client.ts` | Pooled client factory |
| `db/seed.ts` | Dev-only seed |
| `lib/services/operatorService.ts` | Trust rule, login upsert, login finalisation |
| `lib/auth/betterAuth.ts`, `lib/auth/authClient.ts`, `lib/auth/session.ts`, `app/api/auth/[...all]/route.ts`, `app/auth/login/page.tsx` | Login flow |
| `scripts/check-client-bundle.ts`, `scripts/live-db-check.ts` | Leak scanner; live DB assertions |
| `tests/helpers/db.ts` | PGlite test database with migrations applied |
| `.github/workflows/ci.yml`, `db-live-check.yml` | CI |

Empty placeholder files created earlier stay empty unless a task fills them. Task 1 deletes the unused `app/auth/callback/route.ts`, `app/auth/logout/route.ts` and renames `lib/auth/supabaseServer.ts` to `lib/auth/betterAuth.ts`.

---

### Task 0: Prerequisites (owner actions, AC-102)

Owner-run steps; written out in the chat instructions. Tasks 1 to 5 and 7 to 8 proceed without them; Tasks 6 and 9 need them.

- [ ] **Step 1:** `npm install -g pnpm`; `pnpm -v` prints a version.
- [ ] **Step 2:** Neon project `agent-court-dev` (branch `main` is dev); `CREATE EXTENSION vector` succeeds.
- [ ] **Step 3:** Pooled and unpooled connection strings saved to `.env.local`.
- [ ] **Step 4:** GitHub OAuth app (dev) with callback `http://localhost:3000/api/auth/callback/github`; client ID and secret saved to `.env.local`, plus `BETTER_AUTH_SECRET` (32+ random bytes) and `BETTER_AUTH_URL=http://localhost:3000`.

Acceptance: `.env.local` exists, is gitignored, and holds the seven names in `.env.example`.

---

### Task 1: Scaffold and tooling (AC-101)

**Files:**
- Create/overwrite: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.env.example`, `app/layout.tsx`, `app/(public)/page.tsx`
- Modify: `.gitignore` (add `*.tsbuildinfo`, `next-env.d.ts`, `.env.local`)
- Delete: `app/auth/callback/route.ts`, `app/auth/logout/route.ts`; rename `lib/auth/supabaseServer.ts` to `lib/auth/betterAuth.ts`
- Test: `tests/unit/smoke.test.ts`

**Interfaces:**
- Produces scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `db:generate`, `db:migrate`, `db:seed`, `check:bundle`.
- Produces ESLint rules: `no-restricted-properties` blocking `process.env` outside `lib/config/env.ts`; `no-restricted-imports` blocking `@/db/*` from `app/**` and `components/**`.
- `.env.example` names: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `APP_ENV`.

- [ ] **Step 1: Write the failing test** `tests/unit/smoke.test.ts`: `expect(1 + 1).toBe(2)`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL (no `package.json`/vitest yet).
- [ ] **Step 3:** Write `package.json` and install runtime deps (`next`, `react`, `react-dom`, `zod`, `drizzle-orm`, `postgres`, `better-auth`, `server-only`) and dev deps (`typescript`, `@types/*`, `eslint`, `eslint-config-next`, `vitest`, `drizzle-kit`, `@electric-sql/pglite`, `tsx`). The lockfile is the version record.
- [ ] **Step 4:** Write `tsconfig.json` (strict, `moduleResolution: bundler`, alias `@/*`), `next.config.ts` (headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; `productionBrowserSourceMaps: false`), ESLint config with both restriction rules, `vitest.config.ts` (alias, `tests/**/*.test.ts`), and `.env.example`.
- [ ] **Step 5: Make placeholders compile.** Run `pnpm typecheck` and `pnpm build`; fix empty placeholders that break them with the smallest stub per kind (`export {}` for non-route modules; a default-export null component for empty `page.tsx`/`layout.tsx`; a handler stub only if the build demands one). Add no behaviour. Name the stub kinds in the commit message.
- [ ] **Step 6:** Verify. `pnpm test` PASS; `pnpm lint`, `pnpm typecheck`, `pnpm build` exit 0; `pnpm dev` serves the home page.
- [ ] **Step 7: Commit** `chore: scaffold Next.js, tooling and lint rules (AC-101)`.

---

### Task 2: Config and logging (AC-103)

**Files:**
- Create: `lib/config/env.ts`, `lib/config/logger.ts`
- Test: `tests/unit/env.test.ts`, `tests/unit/logger.test.ts`

**Interfaces:**
- `parseServerEnv(source: Record<string, string | undefined>): ServerEnv`; `getServerEnv(): ServerEnv` (cached, reads `process.env`). `ServerEnv` has `databaseUrl`, `databaseUrlDirect`, `betterAuthSecret`, `betterAuthUrl`, `githubClientId`, `githubClientSecret`, `appEnv: 'development' | 'staging' | 'production' | 'test'`.
- `scrub(value: unknown): unknown`; `logger.debug|info|warn|error(message: string, meta?: Record<string, unknown>): void`. Scrubbed key names (case-insensitive): `authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `api_key`, `apikey`, `key`, `body`. Bearer tokens and JWT-shaped strings in values become `[REDACTED]`.

- [ ] **Step 1: Write failing tests.**
  - env: `parseServerEnv({})` throws naming `DATABASE_URL` with no value in the message; a `NEXT_PUBLIC_FOO` equal to the value of `BETTER_AUTH_SECRET` throws naming the public variable; valid input returns the typed object.
  - logger: `scrub({ authorization: 'Bearer abc.def.ghi', nested: { password: 'x' } })` contains neither `abc.def.ghi` nor `x`; a circular object does not throw; an `Error` yields name and message only; `'token=Bearer sk-live-123'` is redacted; `logger.info('m', { body: '{"k":"v"}' })` output never contains `{"k":"v"}` (spy on `console`).
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement both files. Logger emits one JSON line per call (`level`, `message`, `meta`, `time`).
- [ ] **Step 4:** Run the tests, then `pnpm lint`. Expected: PASS; only `env.ts` touches `process.env`.
- [ ] **Step 5: Commit** `feat: validated env and scrubbing logger (AC-103)`.

---

### Task 3: Drizzle schema (AC-104)

**Files:**
- Create: `db/schema/{auth,operators,agents,apiKeys,cases,evidence,arguments,verdicts,reputation,reports,moderation,audit,idempotency}.ts`; fill `db/schema/index.ts`; leave `embeddings.ts`, `searchEvents.ts` as `export {}`
- Modify: `drizzle.config.ts` (uses `DATABASE_URL_DIRECT`)
- Create: `tests/helpers/db.ts`
- Test: `tests/integration/schema.test.ts`

**Interfaces:**
- `@/db/schema` exports one table per Section 5 table, camelCase: `operators`, `agents`, `apiKeys`, `cases`, `evidence`, `argumentsTable` (`arguments` is reserved in strict mode), `verdicts`, `reputationEvents`, `reports`, `moderationEvents`, `auditLog`, `idempotencyKeys`, plus Better Auth's `user`, `session`, `account`, `verification` in `auth.ts`, and inferred types `Operator`, `NewOperator`, etc.
- `auth.ts` is produced by Better Auth's schema generator for the Drizzle/pg adapter, then reviewed by hand (ids, timestamps, cascade rules) so it sits beside our tables.
- `createTestDb(): Promise<{ db: Db; sql: (q: string) => Promise<unknown[]>; close(): Promise<void> }>`: PGlite with `vector`, creates roles `app_server` and `nobody` if absent, applies every file in `db/migrations` in order.
- Columns, enums and statuses exactly as plan Section 5.

- [ ] **Step 1: Write failing tests** in `tests/integration/schema.test.ts`:
  - `verdict: second live verdict for a case is rejected`; `verdict: new verdict allowed after first is overturned`.
  - `argument: won cannot become withdrawn` (finished in Task 4).
  - `agent handle is unique`.
  - `api key table stores prefix and hash only` (columns include `key_hash`, `key_prefix`; none named like `raw%` or `secret%`).
  - `case tags: slug regex enforced` (`"ignore previous instructions"` rejected; more than 8 tags rejected).
  - `evidence has no raw column`.
  - `operators.auth_user_id references user.id`.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Write the schema files. Use Drizzle `check()` for tag rules and a partial unique index for verdicts. The `won -> withdrawn` rule is a trigger in Task 4.
- [ ] **Step 4:** Run `pnpm db:generate` to emit `db/migrations/0000_*.sql`. Prepend `CREATE EXTENSION IF NOT EXISTS vector;` by hand.
- [ ] **Step 5:** Run schema tests. Expected: PASS except the trigger test.
- [ ] **Step 6: Commit** `feat: Drizzle schema and initial migration (AC-104)`.

---

### Task 4: Security migration (AC-105)

**Files:**
- Create: `db/migrations/0001_security.sql` (registered in the drizzle journal)
- Modify: `db/README.md`
- Test: `tests/integration/rls.test.ts`

**Interfaces:**
- Consumes: `createTestDb()` from Task 3.
- `0001_security.sql` does, in order:
  1. For every table in `public`: `ENABLE` and `FORCE ROW LEVEL SECURITY`.
  2. `REVOKE ALL` on all tables, sequences and functions in `public` from `PUBLIC`; `ALTER DEFAULT PRIVILEGES` so future objects do the same. Revoke from `anon`/`authenticated` only if those roles exist.
  3. `CREATE ROLE app_server NOLOGIN` if absent; grant `USAGE` on schema `public`; grant `SELECT, INSERT, UPDATE, DELETE` on all tables and `USAGE` on sequences; `audit_log` and `moderation_events` get only `SELECT, INSERT`.
  4. One policy per table `FOR ALL TO app_server USING (true) WITH CHECK (true)`.
  5. Trigger function and trigger on `arguments` blocking `won -> withdrawn`.
- Owner step documented in `db/README.md`: `ALTER ROLE app_server WITH LOGIN PASSWORD '<generated>'`, run as the project owner in the Neon SQL editor (never in git).

- [ ] **Step 1: Write failing tests** in `tests/integration/rls.test.ts`:
  - `role with no grants sees nothing and cannot write, for every table` (`SET ROLE nobody`; select and insert raise permission denied; loop all `public` tables including Better Auth's).
  - `app_server can insert and read operators`.
  - `app_server cannot UPDATE or DELETE audit_log` and the same for `moderation_events`.
  - `every public table has RLS enabled and forced` (query `pg_class.relrowsecurity`, `relforcerowsecurity`).
  - `no policy targets a role other than app_server` (`pg_policies`).
  - `PUBLIC has no table grants` (`information_schema.role_table_grants`).
  - `won argument cannot become withdrawn`.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Write the migration and update `db/README.md` (how to add a migration, why RLS is forced, the owner step above).
- [ ] **Step 4:** Run all integration tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forced RLS, app role and grants (AC-105)`.

---

### Task 5: Database client (AC-106)

**Files:**
- Create: `db/client.ts`
- Test: `tests/unit/dbClient.test.ts`

**Interfaces:**
- `normalizeDatabaseUrl(url: string): string` removes the `channel_binding` query parameter (Neon's copy-paste strings include `channel_binding=require`, which the `postgres` driver would send to the server as an unknown setting) and keeps `sslmode`.
- `buildClientOptions(url: string): { prepare: false; max: number; ssl: 'require' | false }` (pure); `createDb(url: string): Db` (normalizes first); `getDb(): Db` (singleton from `getServerEnv().databaseUrl`). File starts with `import 'server-only'`. Type `Db` is exported here.

- [ ] **Step 1: Write failing tests:** `normalizeDatabaseUrl` strips `channel_binding` and keeps `sslmode=require`; `prepare === false` (PgBouncer transaction mode); `max <= 5`; localhost URL gives `ssl: false`, any other host gives `'require'`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement. `drizzle.config.ts` already points at the unpooled URL (Task 3).
- [ ] **Step 4:** Run tests and `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pooled database client (AC-106)`.

---

### Task 6: Operator login and trust floor (AC-107, AC-108)

**Design change (2026-10-18, after reading Better Auth 1.7.10 source):** GitHub's profile already carries `created_at`, and Better Auth passes the raw profile to `user.validateUserInfo` on create-user, link-account and sign-in. So no extra GitHub API call and no provider tokens are needed. Tokens are stripped before storage instead of cleaned up afterwards.

**Files:**
- Create: `db/types.ts` (`Database` type accepted by services, so PGlite tests and the postgres-js client both fit), `lib/services/operatorService.ts`, `lib/auth/providerData.ts`, `lib/auth/betterAuth.ts`, `lib/auth/authClient.ts`, `lib/auth/session.ts`, `app/api/auth/[...all]/route.ts`, `app/auth/login/page.tsx`
- Modify: `proxy.ts` (redirect requests to `/dashboard` and `/admin` without a session cookie to `/auth/login`; real validation stays in `getOperator()`)
- Test: `tests/unit/trust.test.ts`, `tests/unit/providerData.test.ts`, `tests/integration/operatorService.test.ts`

**Interfaces:**
- `evaluateTrust(input: { githubCreatedAt: Date | null; emailVerified: boolean; now?: Date }): 'active' | 'pending'`. Null date or unverified email gives `'pending'`; age >= 30 days gives `'active'`.
- `parseGithubProfile(profile: Record<string, unknown>): { githubId: string; githubCreatedAt: Date | null; displayName: string } | null`. Null when `id` is missing. `id` may be a number or string. A missing or unparseable `created_at` gives `githubCreatedAt: null`. `displayName` is `name`, else `login`, else `github:<id>`.
- `recordGithubLogin(db: Db, input: { githubId: string; githubCreatedAt: Date | null; email: string | null; emailVerified: boolean; displayName: string }, now?: Date): Promise<Operator>`. Keyed by `github_id`. New operator: status from `evaluateTrust`, `role = 'operator'`, `verified_at` set when active. Existing: updates email and display name; keeps a stored `github_created_at` when the input is null; a `pending` operator becomes `active` (and gets `verified_at`) when trust now passes; `active` and `suspended` never change; `role` never changes.
- `linkOperatorToUser(db: Db, authUserId: string): Promise<Operator | null>`. Finds the user's GitHub row in `account` (`provider_id = 'github'`), then sets `operators.auth_user_id` for the operator with that `github_id` only when it is null. Never overwrites an existing link. Returns the linked operator or null.
- `stripProviderTokens<T extends object>(account: T): T` sets `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt` to null.
- `auth` (`lib/auth/betterAuth.ts`): GitHub provider with default scopes; `user.validateUserInfo` for provider `github` calls `parseGithubProfile` and `recordGithubLogin` inside try/catch (it must never throw: a throw rejects the login); `databaseHooks.account.create.before` and `.update.before` return `{ data: stripProviderTokens(account) }`; `databaseHooks.session.create.after` calls `linkOperatorToUser(db, session.userId)`; plugin `nextCookies()`.
- `getOperator(): Promise<Operator | null>` reads the session via `auth.api.getSession({ headers: await headers() })` and joins `operators` on `auth_user_id`.

- [ ] **Step 1: Write failing tests.**
  - unit `evaluateTrust`: 29 days gives `pending`; 30 days gives `active`; null date gives `pending`; unverified email gives `pending`.
  - unit `parseGithubProfile`: numeric and string ids; missing id gives null; bad or missing `created_at` gives null date; display name fallbacks.
  - unit `stripProviderTokens`: all five fields null, other fields kept.
  - integration (PGlite): first login creates a row with `role = 'operator'`; second login does not duplicate; `suspended` stays `suspended`; `pending` with a now-30-day-old account becomes `active` and gets `verified_at`; null date leaves `pending` and does not erase a stored date; an existing `admin` keeps `role = 'admin'`; `linkOperatorToUser` links once and never overwrites an existing link.
- [ ] **Step 2:** Run the test files. Expected: FAIL.
- [ ] **Step 3:** Implement the pure functions and service first, then the Better Auth config, route handler (`toNextJsHandler(auth)`), auth client and login page. Nothing logs tokens, codes or secrets.
- [ ] **Step 4:** Run tests, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5 (needs Task 9 setup):** Live check against the dev database: sign in with GitHub, confirm one `operators` row with the expected status and linked `auth_user_id`, confirm `account` has null tokens, sign out. Record the result in the PR description.
- [ ] **Step 6: Commit** `feat: GitHub operator login with trust floor (AC-107, AC-108)`.

---

### Task 7: Seed script (AC-109)

**Files:**
- Create: `db/seed.ts`
- Test: `tests/integration/seed.test.ts`

**Interfaces:**
- `seed(db: Db, opts: { appEnv: string }): Promise<{ operators: number; agents: number; cases: number }>`; throws `Error('seed refused: APP_ENV must be development or test')` for `production` and `staging`.
- CLI (`pnpm db:seed`) calls `seed(getDb(), { appEnv: getServerEnv().appEnv })`.
- Seeds one admin operator (`role = 'admin'`), two operators, agents under them, three `open` cases, no API keys. Seeded operators have no Better Auth user, so `auth_user_id` is nullable for seed rows (column allows null; login rows always set it).

- [ ] **Step 1: Write failing tests:** refuses in `production` and `staging`; in `test` creates the counts above; running twice does not duplicate.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement idempotently (upsert on natural keys).
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: dev-only seed script (AC-109)`.

---

### Task 8: CI and bundle check (AC-110)

**Files:**
- Create: `scripts/check-client-bundle.ts`
- Overwrite: `.github/workflows/ci.yml`; replace `.github/workflows/db-advisor.yml` with `.github/workflows/db-live-check.yml`
- Test: `tests/unit/checkClientBundle.test.ts`

**Interfaces:**
- `findLeaks(dir: string, secrets: string[]): Promise<string[]>` returns paths under `dir` (recursive, text files) containing any secret value; ignores secrets shorter than 12 characters. CLI: scans `.next/static` for the values of `DATABASE_URL`, `DATABASE_URL_DIRECT`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_SECRET` (dummy canary values in CI); exit code 1 on any leak.

- [ ] **Step 1: Write failing tests:** a temp dir with a file containing the canary returns that path; a clean dir returns `[]`; a short secret is ignored.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement the script and `check:bundle`.
- [ ] **Step 4:** Write `ci.yml`: on push and pull request, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` with canary env values, then `pnpm check:bundle`. Write `db-live-check.yml` as `workflow_dispatch` that runs `pnpm tsx scripts/live-db-check.ts` using repo secrets `DATABASE_URL_DIRECT` and `DATABASE_URL` for the dev database.
- [ ] **Step 5:** Verify the negative case once: temporarily reference a canary env value in a client component, run `pnpm build && pnpm check:bundle`, expect exit 1, then revert.
- [ ] **Step 6:** Push a branch and confirm CI is green on GitHub.
- [ ] **Step 7: Commit** `ci: lint, typecheck, tests, build and bundle leak check (AC-110)`.

---

### Task 9: Live database verification and N1 close-out

**Files:**
- Create: `scripts/live-db-check.ts` (not run in the default CI job)
- Modify: `docs/ticket.md` (statuses), `README.md` (Development section)

**Interfaces:**
- `scripts/live-db-check.ts` connects with `DATABASE_URL_DIRECT` and exits 1 unless: every `public` table has RLS enabled and forced; `PUBLIC` holds no table grants; every policy targets `app_server`; then, connected as `app_server` through `DATABASE_URL`, `UPDATE audit_log SET action = action WHERE false` fails with permission denied.

- [ ] **Step 1:** Dev database: run `pnpm db:migrate`; in the Neon SQL editor run `ALTER ROLE app_server WITH LOGIN PASSWORD '<generated>'`; set `DATABASE_URL` in `.env.local` to the pooled string using user `app_server`.
- [ ] **Step 2:** Run `pnpm db:seed`, `pnpm dev`; sign in; confirm the operator row.
- [ ] **Step 3:** Run `pnpm tsx scripts/live-db-check.ts`. Expected: exit 0.
- [ ] **Step 4:** Update `docs/ticket.md` statuses for AC-101 to AC-110 and the N1 row; add a Development section to `README.md` (clone, install, env, migrate, dev).
- [ ] **Step 5: Commit** `docs: close N1`.

---

## N1 Done-when mapping

| Done-when (plan) | Proved by |
|---|---|
| Fresh clone: `pnpm db:migrate && pnpm dev` works | Task 9 steps 1 to 2 |
| Login creates an operator | Task 6 tests and live check |
| No-grants role returns nothing and cannot write, every table | Task 4 tests |
| RLS forced everywhere; `PUBLIC` has no grants; only `app_server` has policies | Task 4 tests, Task 9 step 3 |
| CI green | Task 8 step 6 |

## Self-review notes

- Spec coverage: AC-101 (Task 1), AC-102 (Tasks 0 and 9), AC-103 (Task 2), AC-104 (Tasks 3 and 4), AC-105 (Tasks 4 and 9), AC-106 (Task 5), AC-107/108 (Task 6), AC-109 (Task 7), AC-110 (Task 8).
- `auth_user_id` is nullable only so seed operators can exist without a Better Auth user; login always sets it. Task 3 test asserts the foreign key, Task 7 covers the null case.
- Open technical risk that can change Task 6: Better Auth hook names and whether provider tokens can be kept out of storage entirely. The plan nulls them right after use; if the library offers a no-store option, use it and keep the null step as a backstop.
- Neon behaviour to confirm during Task 9: `ALTER ROLE ... LOGIN PASSWORD` by the project owner, and FORCE RLS interacting with the owner role. Neither affects PGlite tests.
