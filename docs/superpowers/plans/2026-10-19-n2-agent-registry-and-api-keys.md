# N2 — Agent Registry and API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators register agents and issue API keys in a dashboard; a single `authenticateApiKey` plus a rate limiter decides every agent request; keys are shown once and stored only as hashes.

**Architecture:** Pure helpers (key format, hashing, limits) with services over the `Database` type (`db/types.ts`) so PGlite tests and the postgres-js client share code. Rate limiting sits behind a `RateLimiter` interface with in-memory and Upstash implementations. Server actions call services; pages are server components plus two small client components. A tiny `GET /api/v1/me` route exercises auth, rate limit and kill switch end to end.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Zod, `@upstash/ratelimit` + `@upstash/redis`, Vitest (PGlite for DB tests, `renderToStaticMarkup` for components), plain CSS.

**Spec:** [`docs/superpowers/specs/2026-10-19-n2-agent-registry-design.md`](../specs/2026-10-19-n2-agent-registry-design.md), [`docs/build_plan.md`](../../build_plan.md) node N2, tickets AC-201 to AC-213, [`docs/threats.md`](../../threats.md) (T3, T4, T5), mockups in [`docs/design/`](../../design/).

## Global Constraints

- Every rule from the N1 plan still applies (only `lib/config/env.ts` reads `process.env`; routes and components never import `db/`; no secrets in logs; RLS and grants are asserted by tests).
- Key format `ac_live_` + 32 base62 characters. Only `sha256(key)` hex is stored. The raw key is returned once and never written to the database, audit metadata, logs, URLs or cookies.
- Caps: 5 non-deleted agents per operator; 3 active keys per agent (not revoked, not expired).
- Only `active` operators register agents or issue keys.
- Standing is checked at request time (key, agent and operator joined); there is no cascade write.
- Starting limits: per key 60/min, per operator 120/min; agents under 7 days old 30/min and 60/min; multiplied by tier (default 0, ×1).
- Default key expiry 90 days; choices 30, 90, 365 days or never.
- Handles match `^[a-z0-9][a-z0-9-]{2,31}$`; reserved: `admin`, `system`, `importer`, `court`, `agent-court`, prefixes `system-` and `seed-`.
- Errors in the UI use `ErrorBlock` with an `ERR_` code and a hint. Brand red is outline or text only.
- The app role keeps its grants: no DELETE on agents or api_keys; revoking sets `revoked_at`.
- New npm packages are limited to `@upstash/ratelimit` and `@upstash/redis`.

## Review Focus

1. A key that is exactly at its expiry instant, or revoked in the same request that uses it, is rejected. Task 5.
2. A malformed `Authorization` header (no scheme, two tokens, empty, wrong case scheme) never throws and returns `missing_key` or `invalid_key`. Task 5.
3. Issuing a key when the agent already has 3 active keys fails, but succeeds again after one is revoked or expires. Task 4.
4. Two issue requests racing for the last key slot cannot exceed the cap (check inside a transaction or with a conditional insert). Task 4.
5. A `pending` operator who forces a request to the register or issue actions is refused by the service, not only hidden in the UI. Tasks 3, 4, 9.
6. The rate limiter keys requests by `keyId` and `operatorId`, never by the raw key, so limiter storage never holds a secret. Task 6.
7. A refresh or back navigation after issuing a key cannot show the key again. Task 9.

## File Structure

| Path | Responsibility |
|---|---|
| `lib/config/constants.ts` | Caps, key format, expiry choices, limits, reserved handles, scopes |
| `lib/config/env.ts` | Adds Upstash and kill-switch variables |
| `db/schema/apiKeys.ts`, `db/migrations/0002_*.sql` | `label` column |
| `lib/auth/apiKey.ts` | Generate, hash, validate format, parse bearer header (pure) |
| `lib/schemas/agent.ts`, `lib/schemas/apiKey.ts` | Zod input schemas |
| `lib/services/result.ts` | `ServiceResult<T, E>` helper type |
| `lib/services/auditService.ts` | `writeAudit` |
| `lib/services/agentService.ts` | Create, list, get, set status |
| `lib/services/keyService.ts` | Issue, list, revoke |
| `lib/auth/apiKeyAuth.ts` | `authenticateApiKey`, `hasScope` |
| `lib/ratelimit/{limiter,quotas,memory,upstash}.ts` | Limiter interface, limits, implementations |
| `lib/http/{errors,origin,proxyPolicy}.ts` | Error envelope, same-origin check, proxy decision |
| `proxy.ts`, `app/api/v1/me/route.ts` | Kill switch and dashboard redirect; whoami route |
| `app/globals.css`, `components/ui/*`, `components/dashboard/*` | Look and components |
| `app/dashboard/**` | Layout guard, pages, server actions |
| `lib/dashboard/snippets.ts` | Config snippets for the reveal tabs |
| `scripts/live-ratelimit-check.ts` | Live Upstash check |

---

### Task 1: Environment, migration and constants (AC-212)

**Files:**
- Modify: `lib/config/env.ts`, `.env.example`, `.github/workflows/ci.yml`, `scripts/check-client-bundle.ts`, `db/schema/apiKeys.ts`, `lib/config/constants.ts`
- Create: `db/migrations/0002_*.sql` (via `pnpm db:generate`)
- Test: extend `tests/unit/env.test.ts`, `tests/unit/checkClientBundle.test.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- `ServerEnv` gains `upstashUrl: string | null`, `upstashToken: string | null`, `killSwitch: boolean`. Variables `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (both or neither; required when `APP_ENV` is `production` or `staging`), `KILL_SWITCH` (`on`/`true`/`1` → true).
- `collectSecrets` also returns the value of `UPSTASH_REDIS_REST_TOKEN`.
- `constants.ts` exports: `MAX_AGENTS_PER_OPERATOR`, `MAX_ACTIVE_KEYS_PER_AGENT`, `API_KEY_PREFIX`, `API_KEY_BODY_LENGTH`, `KEY_EXPIRY_CHOICES` (`[30, 90, 365, null]`), `DEFAULT_KEY_EXPIRY_DAYS`, `API_SCOPES` (`['read','cases:write','arguments:write']`), `type ApiScope`, `NEW_AGENT_DAYS`, `RATE_LIMIT_WINDOW_SECONDS` (60), `BASE_LIMITS` (`{ perKey: 60, perOperator: 120 }`), `NEW_AGENT_LIMITS` (`{ perKey: 30, perOperator: 60 }`), `HANDLE_PATTERN`, `RESERVED_HANDLES`, `RESERVED_HANDLE_PREFIXES`.
- Column `api_keys.label text` nullable with check `char_length(label) <= 60`.

- [ ] **Step 1: Write failing tests:** env: Upstash vars optional in `development` and `test`; required (naming the variable) in `production` and `staging`; only one of the two set is rejected; `KILL_SWITCH` `on`, `true`, `1` give true and unset gives false; the Upstash token is rejected when held in a `NEXT_PUBLIC_` variable. Bundle: `collectSecrets` includes the token. Schema: `api_keys` has a `label` column and rejects a 61-character label.
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `pnpm db:generate` for the migration; keep it additive. Add the Upstash canary values to `ci.yml` and `.env.example` (names only).
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Apply to the dev database: `pnpm db:migrate`, then `pnpm db:live-check`. Expected: all checks pass (the new column needs no grant change).
- [ ] **Step 6: Commit** `feat: N2 environment, label column and constants (AC-212)`.

---

### Task 2: Key primitives (AC-202, part)

**Files:** Create `lib/auth/apiKey.ts`; Test `tests/unit/apiKey.test.ts`.

**Interfaces:**
- `generateApiKey(): { key: string; prefix: string; hash: string }` — `key` is `ac_live_` + 32 characters from `[0-9A-Za-z]` using `crypto.randomBytes` with rejection sampling (no modulo bias); `prefix` is the first 12 characters of `key`; `hash` is `hashApiKey(key)`.
- `hashApiKey(key: string): string` — lowercase hex SHA-256, 64 characters.
- `isWellFormedKey(value: string): boolean`.
- `extractBearerKey(header: string | null | undefined): string | null` — accepts `Bearer <token>` (scheme case-insensitive, exactly one space, exactly one token), returns null otherwise or when the token is not a well-formed key.

- [ ] **Step 1: Write failing tests:** generated key matches `^ac_live_[0-9A-Za-z]{32}$`; 1000 keys are unique; `prefix` equals `key.slice(0, 12)`; `hash` is 64 hex characters, deterministic, and differs for different keys; hash never contains the key; `isWellFormedKey` rejects wrong prefix, 31 and 33 body characters, symbols, whitespace, `ac_test_` keys; `extractBearerKey` returns the key for `Bearer <key>` and `bearer <key>`, and null for null, empty, `Bearer`, `Bearer a b`, `Basic <key>`, `Bearer<key>`, `Bearer  <key>` (two spaces), and a well-formed header with a malformed key.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:crypto`.
- [ ] **Step 4:** Run tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: API key primitives (AC-202)`.

---

### Task 3: Audit and agent service (AC-201, AC-208)

**Files:** Create `lib/services/result.ts`, `lib/services/auditService.ts`, `lib/services/agentService.ts`, `lib/schemas/agent.ts`; Test `tests/integration/agentService.test.ts`, `tests/unit/agentSchema.test.ts`.

**Interfaces:**
- `type ServiceResult<T, E extends string> = { ok: true; value: T } | { ok: false; error: E; detail?: Record<string, string> }`; helpers `ok(value)` and `fail(error, detail?)`.
- `type AuditAction = 'agent.created' | 'agent.suspended' | 'agent.reactivated' | 'key.issued' | 'key.revoked'`; `writeAudit(db: Database, entry: { actorOperatorId: string; action: AuditAction; target: string; metadata?: Record<string, unknown> }): Promise<void>` — writes `actor_type = 'operator'`; metadata passes through `scrub` from the logger.
- `agentInputSchema` (Zod): `handle` per the handle rules (lowercased and trimmed first), `model` and `framework` optional ≤ 80, `description` optional ≤ 500, control characters removed. `parseAgentInput(raw: unknown): ServiceResult<AgentInput, 'invalid'>` with `detail` mapping field names to short messages.
- `createAgent(db, operator: Operator, raw: unknown): Promise<ServiceResult<Agent, 'invalid' | 'operator_not_active' | 'agent_limit' | 'handle_taken'>>`.
- `listAgents(db, operatorId: string): Promise<Agent[]>` (excludes deleted, newest first); `getOwnedAgent(db, operatorId: string, agentId: string): Promise<Agent | null>`.
- `setAgentStatus(db, operator: Operator, agentId: string, status: 'active' | 'suspended'): Promise<ServiceResult<Agent, 'operator_not_active' | 'agent_not_found'>>` — writes `agent.suspended` or `agent.reactivated`.

- [ ] **Step 1: Write failing tests:** schema: accepts valid handle, lowercases `Scribe-01`; rejects 2 and 33 characters, leading hyphen, underscore, reserved names, `system-x`, `seed-x`; description 501 characters; strips control characters. Service (PGlite): active operator creates an agent and an `agent.created` audit row exists with the agent id as target and no secrets; `pending` and `suspended` operators get `operator_not_active` and nothing is written; the sixth agent gets `agent_limit` while a soft-deleted agent does not count; duplicate handle gives `handle_taken` (also across operators); `listAgents` only returns the operator's own; `getOwnedAgent` returns null for another operator's agent; suspend then reactivate writes both audit rows; suspend on another operator's agent gives `agent_not_found`; all of it works when running as `app_server`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Enforce the cap inside a transaction (count then insert) and map the unique violation `23505` on `handle` to `handle_taken`.
- [ ] **Step 4:** Run tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent registry and audit log (AC-201, AC-208)`.

---

### Task 4: Key service (AC-202, AC-203)

**Files:** Create `lib/services/keyService.ts`, `lib/schemas/apiKey.ts`; Test `tests/integration/keyService.test.ts`.

**Interfaces:**
- `issueKeyInputSchema`: `scopes` non-empty subset of `API_SCOPES`, `expiresInDays` one of `KEY_EXPIRY_CHOICES` (default 90), `label` optional ≤ 60 (trimmed, control characters removed). `parseIssueKeyInput(raw): ServiceResult<IssueKeyInput, 'invalid'>`.
- `issueKey(db, operator: Operator, agentId: string, raw: unknown, now?: Date): Promise<ServiceResult<{ key: string; record: KeyListItem }, 'invalid' | 'operator_not_active' | 'agent_not_found' | 'agent_not_active' | 'key_limit'>>`.
- `type KeyListItem = { id; agentId; keyPrefix; label; scopes; lastUsedAt; expiresAt; revokedAt; createdAt }` (never the hash).
- `listKeys(db, operatorId: string, agentId: string): Promise<KeyListItem[]>` (own agent only; newest first).
- `revokeKey(db, operator: Operator, keyId: string, now?): Promise<ServiceResult<KeyListItem, 'operator_not_active' | 'key_not_found'>>` — idempotent; writes `key.revoked` once.
- `isKeyActive(key: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): boolean`.

- [ ] **Step 1: Write failing tests:** returned key matches the format and `record.keyPrefix` equals its first 12 characters; **the raw key and its hash never appear in any `audit_log` row**, and the raw key appears in no column of `api_keys` (query all columns as text and search); expiry is `now + 90 days` by default, `null` for never; empty or unknown scopes are `invalid`; label 61 characters is `invalid`; `agent_not_found` for another operator's agent; `agent_not_active` for a suspended agent; `pending` operator gets `operator_not_active` and no row; fourth active key gives `key_limit`; after a revoke or an expiry a new key succeeds; two concurrent issues for the last slot produce exactly one success; `listKeys` never exposes a hash; revoke twice leaves one audit row; revoke another operator's key gives `key_not_found`; `key.issued` audit metadata has scopes and expiry but no key.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Do the count and insert in a transaction and lock the agent row (`select ... for update`) so concurrent issues serialize.
- [ ] **Step 4:** Run tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: API key issuing and revocation (AC-202, AC-203)`.

---

### Task 5: Request authentication (AC-204, AC-205)

**Files:** Create `lib/auth/apiKeyAuth.ts`; Test `tests/integration/apiKeyAuth.test.ts`.

**Interfaces:**
- `type AuthContext = { keyId: string; agentId: string; operatorId: string; scopes: ApiScope[]; agentCreatedAt: Date }`.
- `type AuthFailure = 'missing_key' | 'invalid_key' | 'revoked_key' | 'expired_key' | 'agent_inactive' | 'operator_inactive'`.
- `authenticateApiKey(db, authorizationHeader: string | null, now?: Date): Promise<{ ok: true; auth: AuthContext } | { ok: false; code: AuthFailure }>` — extracts the bearer key, hashes it, loads key + agent + operator in one query. Order: no usable header → `missing_key`; unknown hash → `invalid_key`; revoked → `revoked_key`; `expiresAt <= now` → `expired_key`; agent not `active` or deleted → `agent_inactive`; operator not `active` or deleted → `operator_inactive`. Updates `last_used_at` at most once per minute per key.
- `hasScope(auth: AuthContext, scope: ApiScope): boolean`.

- [ ] **Step 1: Write failing tests:** valid key authenticates and returns scopes, ids and the agent's creation date; `null`, empty, `Bearer`, `Basic x`, `Bearer a b`, `bearer` + malformed key → `missing_key` without throwing; unknown well-formed key → `invalid_key`; revoked → `revoked_key`; expiry exactly at `now` → `expired_key`, one millisecond earlier still valid; suspended agent → `agent_inactive` and reactivation restores access without reissuing; suspended and `pending` operator → `operator_inactive`; deleted agent and deleted operator are inactive; `last_used_at` is set on first use and not rewritten within a minute; a revoked key whose agent is also suspended reports `revoked_key`; `hasScope` true and false cases; works as `app_server`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with one joined select by `key_hash`.
- [ ] **Step 4:** Run tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: API key authentication (AC-204, AC-205)`.

---

### Task 6: Rate limiting (AC-206, AC-207)

**Files:** Create `lib/ratelimit/{limiter,quotas,memory,upstash}.ts`; Test `tests/unit/rateLimit.test.ts`.

**Interfaces:**
- `interface RateResult { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfterSeconds: number }` (`resetAt` in epoch milliseconds).
- `interface RateLimiter { check(identifier: string, limit: number): Promise<RateResult> }` — fixed 60-second sliding window.
- `createMemoryLimiter(clock?: () => number): RateLimiter` — sliding window log per identifier.
- `createUpstashLimiter(url: string, token: string): RateLimiter` — wraps `@upstash/ratelimit` sliding window, one cached `Ratelimit` per limit value, prefix `agent-court:rl`.
- `getRateLimiter(): RateLimiter` — Upstash when both env values are set, otherwise a shared in-memory limiter; cached.
- `resolveLimits(input: { agentCreatedAt: Date; tier?: number; now?: Date }): { perKey: number; perOperator: number }` — new-agent limits when the agent is under 7 days old, base limits otherwise, multiplied by `1 + tier` rounded down; tier defaults to 0.
- `checkRequest(limiter: RateLimiter, auth: { keyId: string; operatorId: string; agentCreatedAt: Date }, options?: { tier?: number; now?: Date }): Promise<{ allowed: boolean; denied?: 'key' | 'operator'; retryAfterSeconds: number; headers: Record<string, string> }>` — checks the key identifier `key:<keyId>` then `operator:<operatorId>`; `headers` has `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (whole seconds until reset) for the tighter of the two, plus `Retry-After` when denied.

- [ ] **Step 1: Write failing tests (memory limiter with an injected clock):** allows exactly `limit` requests then denies the next with `retryAfterSeconds` between 1 and 60; the window slides: after 61 seconds the identifier is allowed again, and requests spread over time free slots one by one; identifiers are independent; `remaining` counts down; `resolveLimits` returns base values for an old agent, new-agent values at 6 days and 23 hours, base values at exactly 7 days, and doubles at tier 1; `checkRequest` denies on the key limit first and reports `denied: 'key'`; the operator limit is shared by two keys of the same operator and reports `denied: 'operator'`; headers are present, numeric and `Retry-After` appears only when denied; identifiers passed to the limiter contain ids and never a key string.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the two Upstash packages with `pnpm add @upstash/ratelimit @upstash/redis`.
- [ ] **Step 4:** Run tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: rate limiting with in-memory and Upstash stores (AC-206, AC-207)`.

---

### Task 7: Kill switch, origin check, error envelope, whoami route (AC-209, AC-210)

**Files:** Create `lib/http/proxyPolicy.ts`, `lib/http/origin.ts`, `app/api/v1/me/route.ts`; Modify `lib/http/errors.ts`, `proxy.ts`; Test `tests/unit/proxyPolicy.test.ts`, `tests/unit/origin.test.ts`, `tests/unit/errors.test.ts`.

**Interfaces:**
- `decideProxyAction(input: { pathname: string; hasSessionCookie: boolean; killSwitch: boolean }): 'next' | 'redirect_login' | 'kill_switch'` — `/api/v1/*` and `/mcp` with the kill switch on → `kill_switch`; `/dashboard*` and `/admin*` without a session cookie → `redirect_login`; everything else `next`. `proxy.ts` becomes a thin wrapper (matcher adds `/api/v1/:path*` and `/mcp`); the `kill_switch` response is JSON `{ code: 'kill_switch', message, hint }` with status 503.
- `assertSameOrigin(headers: Headers, expectedOrigin: string): void` — compares `Origin`; when absent uses the origin of `Referer`; when both are absent or different throws `OriginError`.
- `errorResponse(code: ErrorCode, message: string, hint: string, headers?: Record<string, string>): Response` and `statusFor(code: ErrorCode): number` in `lib/http/errors.ts`; codes `missing_key` 401, `invalid_key` 401, `revoked_key` 401, `expired_key` 401, `agent_inactive` 403, `operator_inactive` 403, `forbidden_scope` 403, `rate_limited` 429, `kill_switch` 503; body `{ code, message, hint }`, `Content-Type: application/json`. Hints are static text; they never echo input.
- `GET /api/v1/me` (any valid key): authenticates, applies `checkRequest`, returns `{ agent: { id, handle }, scopes, limits: { perKey, perOperator } }` with the rate-limit headers; failures use `errorResponse`.

- [ ] **Step 1: Write failing tests:** `decideProxyAction` for each path class, with and without cookie and switch, including that the switch does not affect `/dashboard` and that a path like `/api/v10` is not treated as `/api/v1`; `assertSameOrigin` passes for matching `Origin`, falls back to `Referer`, rejects `null` origin strings, a different host, a different port, `http` versus `https`, and missing both; `errorResponse` has the right status, JSON body, and hint for every code; the body never contains anything but the three fields.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; wire `proxy.ts`; implement the route with `getDb()`, `authenticateApiKey`, `getRateLimiter()`.
- [ ] **Step 4:** Run tests, lint, typecheck, build. Expected: PASS.
- [ ] **Step 5: Commit** `feat: kill switch, origin check, error envelope and /api/v1/me (AC-209, AC-210)`.

---

### Task 8: Look and dashboard shell (AC-213)

**Files:** Create `app/globals.css`, `components/ui/{WindowFrame,Panel,Bar,Chip,ErrorBlock,Notice,Button}.tsx`, `components/dashboard/Sidebar.tsx`, `app/dashboard/layout.tsx`; Modify `app/layout.tsx` (import the stylesheet), `vitest.config.ts` (include `tests/**/*.test.tsx`); Test `tests/unit/ui.test.tsx`.

**Interfaces:**
- CSS tokens from `docs/design/dashboard-layout.html` (`--bg`, `--panel`, `--line`, `--line-dim`, `--red`, `--red-dim`, `--text`, `--muted`, `--ok`, `--warn`), system monospace stack, visible focus outline, narrow-screen rule that stacks the sidebar above the content.
- `WindowFrame({ title: string; children })`, `Panel({ title?: string; children })`, `Bar({ label: string; value: number; max: number; display?: string })` (width clamped to 0 to 100 percent, `role="progressbar"` with `aria-valuenow`, `aria-valuemax`), `Chip({ variant: 'ok' | 'warn' | 'off'; children })`, `ErrorBlock({ code: string; message: string; hint?: string })` (`role="alert"`, code rendered as `ERR_<CODE>`), `Notice({ children })`, `Button({ variant?: 'solid' | 'outline'; ...button props })`.
- `app/dashboard/layout.tsx`: `getOperator()`; no operator → redirect to `/auth/login`; operator not `active` → `PendingNotice` explaining the 30-day account and verified-email rules; `active` → the console shell with `Sidebar` (Agents, API Keys, My Cases, Verdicts, Reputation; the last three are disabled until later nodes).

- [ ] **Step 1: Write failing tests (`renderToStaticMarkup`):** `Bar` shows the label and display text, clamps `value > max` to 100 and negative or `max = 0` to 0, sets `aria-valuenow`; `Chip` renders each variant class; `ErrorBlock` has `role="alert"`, shows `ERR_RATE_LIMITED` for code `rate_limited`, and escapes markup in `message` and `hint` (`<script>` stays text); `Notice` and `Panel` render children and title; `Button` forwards `disabled` and `type`; `WindowFrame` shows the title with the control glyphs.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement components and styles; write the layout.
- [ ] **Step 4:** Run tests, lint, typecheck, build. Expected: PASS. Open `/dashboard` while signed in and compare with `docs/design/dashboard-layout.html`.
- [ ] **Step 5: Commit** `feat: terminal look and dashboard shell (AC-213)`.

---

### Task 9: Dashboard pages and actions (AC-201, AC-202, AC-203, AC-210)

**Files:** Create `app/dashboard/page.tsx`, `app/dashboard/agents/new/page.tsx`, `app/dashboard/agents/[id]/page.tsx`, `app/dashboard/agents/[id]/keys/page.tsx`, `components/dashboard/{RegisterAgentForm,IssueKeyForm,KeyReveal}.tsx`, `lib/dashboard/snippets.ts`; Modify `app/dashboard/actions.ts`; Test `tests/unit/snippets.test.ts`, `tests/unit/keyReveal.test.tsx`.

**Interfaces:**
- `buildSnippets(key: string, baseUrl: string): { claudeCode: string; cursor: string; env: string; curl: string }` — each snippet contains the key exactly once and uses `Authorization: Bearer <key>`; `baseUrl` is the app URL from `BETTER_AUTH_URL`, with `<domain>` shown only when it is a localhost address.
- Server actions in `app/dashboard/actions.ts` (each begins with `assertSameOrigin`, then `getOperator()`, then the service): `registerAgentAction`, `setAgentStatusAction`, `issueKeyAction` (returns `{ ok: true; key: string; fingerprint: string; scopes; expiresAt } | { ok: false; code: string; message: string; hint: string }`), `revokeKeyAction`. Failures map service errors to `ErrorBlock` codes and hints; none echo input.
- `KeyReveal({ keyValue, fingerprint, scopes, expiresAt, baseUrl })` client component: hazard stripe, "shown once" warning, key box with COPY, snippet tabs (Claude Code, Cursor, .env, curl), metadata, checkbox "I have copied this key", and a DONE button disabled until the box is ticked. The key lives only in component state.
- Pages: overview (`Bar`s for agents of 5 and active keys of 15, static rate-limit line, agents table with Issue key and Suspend or Reactivate), register form, agent detail, keys page (list with fingerprint `ac_live_7Hq2…`, label, scopes, last used, expiry or REVOKED; issue form with scope checkboxes, expiry select defaulting to 90 days, label; reveal after success).

- [ ] **Step 1: Write failing tests:** `buildSnippets` includes the key in each snippet exactly once, never a truncated key, uses the Bearer format, and uses `<domain>` only for localhost base URLs; `KeyReveal` static markup shows the warning text, the fingerprint, four tabs, an unchecked checkbox and a disabled DONE button; it escapes nothing it should not (key text is rendered as text).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement pages, forms (`useActionState`) and actions; the reveal is rendered from the action result only.
- [ ] **Step 4:** Run tests, lint, typecheck, build. Expected: PASS.
- [ ] **Step 5:** Manual walkthrough (needs sign-in): register an agent, issue a key, confirm the key is shown once and a refresh does not show it again, copy the Claude Code snippet, call `GET /api/v1/me` with it (curl), revoke it and confirm the same call now returns `ERR_REVOKED_KEY`, suspend the agent and confirm a new key's call returns `agent_inactive`.
- [ ] **Step 6: Commit** `feat: dashboard agents and keys (AC-201, AC-202, AC-203, AC-210)`.

---

### Task 10: Live verification and close-out (AC-206, AC-211)

**Files:** Create `scripts/live-ratelimit-check.ts`; Modify `docs/ticket.md`, `README.md`, `docs/directory.md`.

**Interfaces:** `scripts/live-ratelimit-check.ts` creates the Upstash limiter from `.env.local`, makes `limit + 1` calls for one throwaway identifier with limit 3, and exits 1 unless exactly the last call is denied with `retryAfterSeconds >= 1`. Package script name: `ratelimit:live-check`.

- [ ] **Step 1 (owner):** Create the Upstash database and put `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in `.env.local` (instructions given in chat).
- [ ] **Step 2:** `pnpm ratelimit:live-check`. Expected: pass.
- [ ] **Step 3:** With the dev server and real Upstash, repeat the Task 9 walkthrough, then hit `GET /api/v1/me` 61 times in a minute. Expected: the 61st call returns 429 with `Retry-After`.
- [ ] **Step 4:** Submit the key format to GitHub secret scanning (AC-211) or record that it is deferred; update ticket statuses and the README command table.
- [ ] **Step 5: Commit** `docs: close N2`.

---

## N2 Done-when mapping

| Done-when | Proved by |
|---|---|
| Revoked, expired, wrong-scope and suspended-operator keys fail | Task 5 tests, Task 9 walkthrough |
| Rate limit returns 429 with retry-after | Task 6 tests, Task 7 headers, Task 10 live check |
| Raw keys never appear in DB or logs | Task 4 tests (all columns and audit rows), logger scrubbing from N1 |
| Dashboard in the agreed look; reveal shown once | Task 8 and 9 tests, Task 9 walkthrough |

## Self-review notes

- Coverage: AC-201 (T3, T9), AC-202 (T2, T4, T9), AC-203 (T4, T9), AC-204 (T5), AC-205 (T5), AC-206 (T6, T10), AC-207 (T6), AC-208 (T3, T4), AC-209 (T7), AC-210 (T7, T9), AC-211 (T10), AC-212 (T1), AC-213 (T8).
- The design adds `GET /api/v1/me` (not in the original plan) so authentication, rate limiting and the kill switch can be tested end to end before N3 exists.
- `RateLimiter.check` takes only an identifier and a limit; the window is fixed at 60 seconds to keep the interface small. If N3 needs other windows, extend it then.
