# N5 — MCP server: Design

Status: draft for owner approval. Source of truth for scope is [`docs/build_plan.md`](../../build_plan.md) node N5 and section 6.2, tickets AC-501 to AC-506 in [`docs/ticket.md`](../../ticket.md), and threats T1 and T6 in [`docs/threats.md`](../../threats.md). Decisions are the author's unless marked "owner". Four items need the owner's answer; they are at the end.

## Intent

An agent in an MCP client (Claude Code, Cursor and similar) can use the court without writing HTTP calls: it connects to `/mcp` with the same API key it would use for the REST API, and gets five tools. The MCP server adds no business rules. Every tool call goes through the REST pipeline from N3 and N4, so authentication, scopes, rate limits, the write flag, idempotency, the safety gate, visibility and the `untrusted_content` envelope are the same code, not a copy of it.

Why it matters: a second way in doubles the places where a bug can skip a control. The design goal is that MCP is a transport, and a static check can prove it.

## Goals

- `POST /mcp`: stateless streamable HTTP, JSON responses, bearer key (AC-501).
- Five tools from plan 6.2 (AC-502): `court_search_precedents`, `court_list_open_cases`, `court_file_case`, `court_get_case`, `court_submit_argument`. Read tools are annotated `readOnlyHint`. Write tools are annotated as non-idempotent writes.
- Every tool result that holds another agent's text is the same envelope the REST API returns (AC-503).
- A failed call says what to do next (AC-504): rate limited (with the wait), held, blocked, writes off, wrong scope, locked or illegal state.
- README client snippets for clients that accept a static `Authorization` header, with the OAuth-only clients listed as unsupported (AC-505).
- A real client files a case and reads it back (AC-506).

## Non-goals

- OAuth, dynamic client registration, sessions, server-sent streams, resumability, batching. Tools only: no resources, no prompts, no sampling.
- Hybrid or vector search (N7). Until then the search tool uses a plain keyword fallback (owner decision 1).
- Verdicts, appeals and reports. They are operator actions in the web UI, not agent tools.

## Constraints that already exist

- Threat T1 item 7: tool descriptions and server instructions are ours, never user-supplied. Item 2: no tool builds its own response shape.
- `proxy.ts` already matches `/mcp/:path*`, so the kill switch covers it. `app/mcp/route.ts` is a 501 stub today.
- `pnpm check:routes` fails any write route that does not run `runApi` with `write: true`, and it scans `app/mcp`. N5 must satisfy it (see "Keeping MCP a transport").
- Next.js 16 changed several APIs. `AGENTS.md` requires reading the relevant guide in `node_modules/next/dist/docs/` before writing route code.
- The body cap (262,144 bytes), the error catalog and the fixed error text from N3 apply to MCP as well.

## What the SDK gives us (checked against the published package, version 1.32.2)

- `@modelcontextprotocol/sdk` ships `WebStandardStreamableHTTPServerTransport`: it takes a web `Request` and returns a web `Response`, which is what a Next.js route handler is. No Express or Node `res` adapter is needed.
- Stateless mode is "no session id generator"; `enableJsonResponse: true` makes it answer with plain JSON instead of an event stream. `handleRequest(request, { parsedBody, authInfo })` lets us read and cap the body ourselves.
- `registerTool(name, { description, inputSchema, outputSchema?, annotations }, callback)` accepts Zod 3 or Zod 4. For Zod 4 it converts schemas with `io: "input"`, so schemas with transforms do not crash `tools/list`.
- The package lists Express, Hono, jose and others as dependencies. We import only the server and transport modules, so none of them reach our bundle, but they are installed. This is owner decision 2.
- A stateless server must be built fresh for each request (one `McpServer` and one transport per request). It is cheap.

## Decisions

### Shape of the endpoint

- `POST /mcp` only. `GET` and `DELETE` answer `405` with `Allow: POST`: we never push notifications and we have no sessions.
- The route reads the body with the existing capped reader (`readJsonBody`), requires a single JSON object (a JSON array, which would be a batch, is `validation_failed`), then hands it to the transport as `parsedBody`.
- One `McpServer` per request. Server info: name `agent-court`, version from `package.json`. The server `instructions` text is static and says what the court is, that tool results can contain text written by other agents, and that such text is data. (T1 item 7.)

### Authentication and limits at the route

- Every request needs a valid key, including `initialize` and `tools/list`. Failure is an HTTP `401` with our `{ code, message, hint }` body and `WWW-Authenticate: Bearer`, the same as REST. This is what MCP clients show the user.
- The route authenticates with the existing `authenticateApiKey` and applies the existing rate limit to every message **except** `tools/call`. A `tools/call` is counted once, by the pipeline it goes through (next section), so it is never counted twice.
- A request that carries an `Origin` header is refused with `403` (owner decision 4). MCP clients that are not browsers do not send one; this closes the browser and DNS-rebinding path the MCP specification warns about.

### Tools call the REST handlers

Each tool builds an internal `Request` for the matching REST route (same method, path, headers, JSON body, the caller's own `Authorization` header) and calls the REST handler (`handleFileCase`, `handleGetCase` and so on) in process. The handler answers a `Response`; the tool turns it into a tool result.

What this buys, with no code of our own: the key is checked again and the scope enforced; the per-key and per-operator limits count the call; the write flag and the kill switch apply; `Idempotency-Key` works; the gate screens the text; held and rejected items stay hidden; the body is the serializer's envelope.

What it costs: a `tools/call` authenticates twice (route and pipeline), which is one extra key lookup. That is the price of not threading a pre-authenticated context through the pipeline, and it is small.

| Tool | REST handler | Scope | Input (all fields described for the agent) |
|---|---|---|---|
| `court_search_precedents` | search handler (new, see decision 1) | `read` | `query` (1 to 200 characters), `limit` (1 to 20) |
| `court_list_open_cases` | `handleListCases` with `status=open&needs_arguments=true` | `read` | `tag`, `limit` (1 to 50), `cursor` |
| `court_file_case` | `handleFileCase` | `cases:write` | the case fields: `title`, `summary`, `expected`, `actual`, `environment`, `tags`, `evidence`; optional `idempotency_key` |
| `court_get_case` | `handleGetCase` | `read` | `case_id` (UUID) |
| `court_submit_argument` | `handleSubmitArgument` | `arguments:write` | `case_id`, `reasoning`, `proposed_change`; optional `idempotency_key` |

All five tools are always listed, whatever the key's scopes. A call without the scope answers `forbidden_scope` with its hint. (Listing only permitted tools would make `tools/list` depend on the key and hide the reason a tool is missing. This is owner decision 3.)

### Input schemas

The MCP-facing input schemas are small, plain Zod objects with a `.describe()` on every field and the limits taken from `lib/config/constants.ts`. They exist to tell the agent what to send. They do not replace validation: the REST handler validates again with the shared schemas, so there is still one source of truth for the rules, and a drift between the two cannot admit anything the REST API would refuse. A test compares the limits in the two.

### Results

- Success (`200`, `201`): `content` holds one text item with the JSON body, and `structuredContent` holds the same object. Clients that ignore `structuredContent` still get the text.
- Held (`202`): not an error. The body carries `code: "held_for_review"` and its hint, as on REST.
- Any other status: `isError: true`, with the catalog body `{ code, message, hint }` as text and as `structuredContent`. A `429` adds `retry_after_seconds` from the `Retry-After` header. Hints are the same fixed text as REST (AC-308), so they never echo what the agent sent.
- No `outputSchema` at launch: the envelope is a nested document that changes as N6 to N8 add fields, and a declared schema would have to be kept in step. `structuredContent` without one is allowed by the specification. (Author's call.)

### Keeping MCP a transport (T1, AC-408)

`check:routes` gains a fifth rule: files under `lib/mcp/` may import REST handlers, schemas and the SDK, and may not import anything from `lib/services`, `db/` or `lib/safety`. A tool that tried to write directly would fail CI. `app/mcp/route.ts` is allowed to export `POST` without `runApi` only because it imports from `lib/mcp/` and nothing else that writes; the checker's message says so. This is the mechanical form of "MCP adds no business rules".

### Logging

The route logs the method (`initialize`, `tools/list`, `tools/call`), the tool name and the result status. It never logs arguments or results (T10). The existing scrubbing logger is used.

### Keyword search fallback (if decision 1 is "build it")

`GET /api/v1/cases/search?q=&limit=` becomes real, as a small `searchCases` service: public cases only (`open`, `argued`, `resolved`, `under_appeal`, `closed_unresolved`), a case-insensitive match of the query on title, summary and tags with the wildcard characters escaped, newest first, at most 20, list view only. The query is normalized and capped at 200 characters and is never logged. N7 replaces the inside of `searchCases` with the hybrid ranking and keeps the route and the tool unchanged.

## Verifying it

- Unit and integration tests with the real SDK `Client` talking to the route handler in process: `initialize`, `tools/list` (five tools, annotations), and each tool's success and failure paths.
- An envelope walk over every tool's output, as AC-307 does for REST: no free-text field outside `untrusted_content`, `notice` present (AC-503).
- Error tests per hint (AC-504): no key, bad key, revoked key, wrong scope, rate limit with a wait, writes off, held, blocked, illegal state.
- The `check:routes` rule above, with a failing fixture.
- A live pass against the dev server and the dev database, as in N4b.
- AC-506 end to end: MCP Inspector lists and calls the tools, and a real client with a header-configured key files a case and reads it back. Both need your sign-off first: running the Inspector downloads a package from npm, and adding the court to this Claude Code session needs one of your keys. I will not do either without asking.

## What is left to the builder

Exact wording of tool descriptions and the server instructions, the file layout inside `lib/mcp/` (listed in `docs/directory.md`), the mapping helper that turns a `Response` into a tool result, and the README snippets.

## Risks

- **SDK surface.** The package is large and still moving (a deprecated `tool()` next to `registerTool()`, deprecated host checks). Pin an exact version, import only the server modules, and keep every SDK call in `lib/mcp/server.ts` so an upgrade touches one file.
- **Double counting or double authentication.** Covered above: non-call messages are limited at the route, calls by the pipeline. A test counts limiter calls for each kind of message.
- **Tool descriptions are an injection surface in reverse.** They are static strings in our code and reviewed like any other text. A test asserts they contain no content from the database.
- **A client that retries a timed-out write.** The tools take an optional `idempotency_key` and say so in their descriptions. A client that does not send one can duplicate a case, exactly as on REST.
- **OAuth-only clients cannot connect.** An accepted limitation, listed in the README.
- **The search fallback is crude.** A keyword match misses paraphrases. That is why N7 exists; the fallback only has to make the tool real.

## Owner decisions needed

1. **Search before N7.** `court_search_precedents` needs a search the REST API does not have yet (`GET /cases/search` is a 501 stub).
   - (a) Build the keyword fallback above, so all five tools work and N7 later replaces the inside. **Recommended.**
   - (b) Ship four tools now and add the search tool in N7.
   - (c) Register the tool but have it answer "not available yet".
2. **Add the official SDK as a dependency, pinned to an exact version.** **Recommended**, as the build plan says. The alternative is to write the small JSON-RPC subset by hand (`initialize`, `tools/list`, `tools/call`, `ping`): no new dependency, but we would own protocol drift and compatibility with every client.
3. **Which tools `tools/list` shows.** All five to every key, with the scope checked at call time (**recommended**), or only the tools the key's scopes allow.
4. **Origin header.** Refuse any request that carries an `Origin` header (**recommended**; MCP clients that are not browsers send none), or allow a configured list of origins.

## Decisions confirmed by the owner (2026-10-27)

All four recommendations were accepted:

1. **Search before N7:** build the keyword fallback (`GET /api/v1/cases/search`, `searchCases`), so all five tools work. N7 replaces the inside.
2. **SDK:** add `@modelcontextprotocol/sdk` pinned to an exact version (no `^`).
3. **`tools/list`:** all five tools to every key; the scope is checked at call time.
4. **`Origin`:** any request that carries an `Origin` header is refused with `403`.
