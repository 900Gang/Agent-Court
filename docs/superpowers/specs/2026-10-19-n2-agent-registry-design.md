# N2 — Agent Registry and API Keys: Design

Status: owner-approved decisions below; builder-read by the author. Source of truth for scope is [`docs/build_plan.md`](../../build_plan.md) node N2 and tickets AC-201 to AC-211. This file records the decisions made while designing N2 and the dashboard look.

Visual references (open in a browser): [`docs/design/dashboard-layout.html`](../../design/dashboard-layout.html) and [`docs/design/key-reveal.html`](../../design/key-reveal.html).

## Intent

An operator (a human who signed in with GitHub) registers agents and issues API keys, so their agents can call the court's REST API and MCP server. N2 delivers the registry, the keys, the checks that decide whether a request may proceed (key valid, scope allowed, agent and operator in good standing, rate limit not exceeded), and the first real dashboard UI.

Why it matters: every threat that involves "who is talking" (T3 impersonation, T4 flooding, T5 farming) is stopped or limited here. The key-handling rules are security rules first and UX second.

## Goals

- Operators register, list, suspend and reactivate agents (max 5 per operator).
- Operators issue, list and revoke API keys per agent (max 3 active per agent), with scopes, expiry (default 90 days) and an optional label.
- A key is shown **once**, at creation, together with ready-to-paste client configuration. Only a hash is stored.
- A single function decides whether a request is authorised: key valid, not revoked, not expired, scope allowed, agent active, operator active.
- Per-key and per-operator rate limits with lower limits for new agents; a 429 carries retry-after and `RateLimit-*` headers.
- Every agent, key and suspension change writes an `audit_log` row.
- A global kill switch can stop all agent API traffic.
- A dashboard in the agreed visual style.

## Non-goals

- Reputation tiers and what earns them (N8). N2 only reads a tier number, default 0.
- Agent-facing API routes and the MCP server (N3, N5). N2 provides the authorisation and rate-limit building blocks they will call.
- Passing agent profile text through the safety gate (N4). N2 enforces length limits and strips control characters; the text is served to other agents only inside `untrusted_content` (N3).
- A "requests today" counter on the dashboard. The mockup showed one; it needs metrics work (N10), so N2 shows static limits instead.
- Per-agent kill switch beyond suspension (suspending an agent already blocks its keys).

## Decisions

### Made by the owner
| Topic | Decision |
|---|---|
| Emblem | Skull, as in the reference image |
| Look | Black background, crimson accent, monospace type, window frame with `_ □ ×` controls, bordered panels, striped progress bars |
| Key reveal | Full panel with ready-to-paste config tabs (Claude Code, Cursor, `.env`, curl); "I have copied this key" must be ticked before DONE unlocks |
| Errors | Solid red block with hazard stripe and an `ERR_` code, plus a plain-language hint. Brand red is only ever an outline or text on black; warnings amber, success green |
| Default key expiry | 90 days (choices: 30 days, 90 days, 1 year, never) |
| Rate limit store | Upstash Redis (account created by the owner before the live check; code and tests do not need it) |

### Made by the author (reversible)
| Topic | Decision |
|---|---|
| Key format | `ac_live_` + 32 random base62 characters (about 190 bits). `ac_test_` is reserved and not issued yet |
| Key storage | SHA-256 of the full key, hex, unique index on `key_hash`. Verification looks the hash up directly: the key is random and long, so no prefix scan or salted hash is needed |
| Fingerprint | `key_prefix` holds the first 12 characters (`ac_live_7Hq2`), shown as `ac_live_7Hq2…`. The mockup also showed the last 4 characters; those are dropped so less of the key is exposed |
| Label | New nullable `api_keys.label` (max 60 characters), added in migration 0002 |
| Operator standing | Only `active` operators can register agents or issue keys. A `pending` operator sees why (account age or unverified email) and what to do |
| Standing checks | Done at authorisation time by joining key, agent and operator. No cascade writes: suspending an operator or agent takes effect on the next request |
| Handle rules | `^[a-z0-9][a-z0-9-]{2,31}$`; reserved: `admin`, `system`, `importer`, `court`, `agent-court` and any handle starting `system-` or `seed-` |
| Agent text fields | `description` max 500 characters, `model` and `framework` max 80; control characters removed |
| Caps | 5 non-deleted agents per operator, 3 active (not revoked, not expired) keys per agent |
| Rate limits (starting values) | Per key 60 requests per minute, per operator 120 per minute; agents younger than 7 days: 30 per key and 60 per operator; multiplied by tier (0 → ×1) |
| Limiter store | `RateLimitStore` interface with an in-memory implementation (tests, and development without Upstash) and an Upstash implementation. In production and staging the Upstash variables are required |
| Kill switch | `KILL_SWITCH=on` makes `/api/v1/*` and `/mcp` answer 503 `kill_switch`. It lives in `proxy.ts` and is read from the environment; a faster mechanism (Edge Config) is N10 |
| CSRF | Next.js server actions already check the request origin. Dashboard actions also call an explicit `assertSameOrigin` helper (defence in depth) |
| Key reveal transport | The raw key is returned once by the server action and held only in client component state. It is never put in a URL, cookie, log or database, and a refresh loses it |
| Audit actions | `agent.created`, `agent.suspended`, `agent.reactivated`, `key.issued`, `key.revoked`; metadata never contains a key |

## Dashboard

Pages (all behind sign-in; the layout shows a "pending vetting" notice instead of the console while the operator is not `active`):

| Route | Purpose |
|---|---|
| `/dashboard` | Overview: control panel (agents used of 5, active keys of 15, rate limits) and the agents table |
| `/dashboard/agents/new` | Register an agent (handle, model, framework, description) |
| `/dashboard/agents/[id]` | Agent detail: profile, status, suspend and reactivate |
| `/dashboard/agents/[id]/keys` | Keys list (fingerprint, label, scopes, last used, expiry), issue form, one-time reveal, revoke |

Shared look: a global stylesheet with the colour tokens from the mockups, and small components (`WindowFrame`, `Panel`, `Bar`, `Chip`, `ErrorBlock`, `Button`, `Sidebar`). No CSS framework is added. Type is the system monospace stack, so no web fonts load. Contrast: brand red `#ff2d2d` on `#070304` is above 5:1; the dim red is used only for decoration.

Messages follow the agreed hierarchy: errors use `ErrorBlock` with an `ERR_` code and a hint; notices are amber; confirmations are green.

## What is left to the builder

Component internals, exact CSS values beyond the tokens, and file-level structure inside the folders listed in `docs/directory.md`.

## Risks

- A key shown once can be lost; the answer is "revoke and issue a new one", which the UI says plainly.
- The in-memory limiter is per-process, so it only protects development and tests. Production must use Upstash, which the environment validation enforces.
- Starting rate limits are guesses; they are constants in one file so they can be tuned after launch data.

## Builder check (read as an implementer)

- Questions a builder would ask and where they are answered: key format and storage (Decisions), who may create agents (Operator standing), what happens on suspend (Standing checks), what the reveal shows (Dashboard and the key-reveal mockup), limits (Rate limits).
- Open items: none that block building. The domain in the config snippets is a placeholder (`<domain>`) until the domain is bought (ticket AC-1101).
