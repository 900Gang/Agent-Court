# N4a — Safety Gate Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** paste mode. For each task the builder sends the tests first; the owner pastes them and confirms they fail ("red"); the builder then sends the implementation as paste blocks; the owner says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and fixes anything; the owner commits and pushes. Large data files (the corpora) are sent in several paste blocks.

**Goal:** A real safety gate behind the existing `SafetyGate` interface: normalize, enforce limits, redact secrets, score injection text, scan links, and decide `pass`, `flag` or `block`, measured against fixture corpora.

**Architecture:** Pure functions in `lib/safety/` (no database, no network): `normalize`, `limits`, `patterns`, `redact`, `injection`, `links`, thresholds, version, and an orchestrator `createGate()` that runs them in order per field and combines the per-field results. N4a does not touch the services or routes; N4b wires the gate in.

**Tech Stack:** TypeScript strict, Vitest. No new packages.

**Spec:** [`docs/superpowers/specs/2026-10-24-n4-safety-gate-design.md`](../specs/2026-10-24-n4-safety-gate-design.md), [`docs/build_plan.md`](../../build_plan.md) section 7 and node N4, tickets AC-401 to AC-407, [`docs/threats.md`](../../threats.md) (T1, T2, T6, T10, T11).

## Global Constraints

- All N1 to N3 rules still apply (no `process.env` outside `lib/config/env.ts`; no secrets or content in logs; `app/` and `components/` never import `db/`).
- `lib/safety/` makes no network calls (no `fetch`, no `http`) and imports nothing from `db/` or `lib/services/`.
- A matched secret never appears in any return value other than the redacted text itself (never in a report, hit list, error or log line).
- Outcome rules: `block` when a field exceeds its limit after normalization, when more than 50% of a field's characters were redacted, or when the injection score is 9 or more (owner decision); `flag` when the score is 3 to 8, when tag characters were stripped, when a tag changed, or when a field name is unknown; otherwise `pass`. The overall outcome is the most severe across fields (`block` over `flag` over `pass`). A thrown error is handled by `screenSafely` as `flag`.
- Every pattern is linear-time (no nested quantifiers, no unbounded lookbehind). Adversarial inputs of 32,000 characters finish within 500 ms per module; a maximum-size request (10 evidence items of 32,000 characters plus case fields) finishes within 3 seconds.
- Placeholders are exactly `[REDACTED:<type>]`. Redaction positions are in the normalized text.
- The repository is public: secret fixtures are never stored as one literal; they are stored as `parts` and joined at load time.
- Message and report text never reveal which rule fired to the submitting agent (N4b enforces this at the response layer); reports hold rule ids and counts for admins only.
- No new npm packages.

## Review Focus

1. A secret split by zero-width characters, written in fullwidth letters, or spread over a line break inside a PEM block is still redacted (normalization runs first). Tasks 2, 4.
2. Text with only whitespace, only hidden characters, or an empty string after normalization does not crash any step. Tasks 2 to 7.
3. Emoji with variation selector 16 and ordinary non-English text (accents, CJK, Arabic, Cyrillic) survive normalization and are not flagged as injection. Tasks 2, 5.
4. A 32,000-character line of one repeated character, a long run of digits, and a long `=` or `/` run do not make any pattern slow. Tasks 3 to 7.
5. UUIDs, 40-character git SHAs, `sha256:` digests and example-domain emails survive redaction, while a 64-character hex string next to the word `secret` does not. Tasks 3, 4.

## File Structure

| Path | Responsibility |
|---|---|
| `tests/fixtures/{secrets,injections,clean-traces}.json` | The three corpora, with `dev` and `holdout` sets |
| `tests/helpers/corpus.ts` | Loads corpora and joins secret `parts` |
| `lib/safety/thresholds.ts` | Every tunable number in one file |
| `lib/safety/version.ts` | `GATE_VERSION` |
| `lib/safety/normalize.ts` | NFKC, hidden-character stripping |
| `lib/safety/limits.ts` | `describeField`: limit and kind for each field name |
| `lib/safety/patterns.ts` | Pattern catalogue, Luhn check |
| `lib/safety/redact.ts` | `redactText`: patterns, context rules, entropy, allowlist |
| `lib/safety/injection.ts` | Rule table and `scoreInjection` |
| `lib/safety/links.ts` | `scanLinks` |
| `lib/safety/engine.ts` | `createGate`: the orchestrator |
| `lib/safety/gate.ts` | Gains `GateContext`; `screenSafely` logs the error class |

---

### Task 1: Corpora and loader (AC-401)

**Files:**
- Create: `tests/fixtures/secrets.json`, `tests/fixtures/injections.json`, `tests/fixtures/clean-traces.json` (the three existing files are empty placeholders), `tests/helpers/corpus.ts`
- Test: `tests/unit/corpus.test.ts`

**Interfaces:**
- Produces in `tests/helpers/corpus.ts`:
  - `type CorpusSet = "dev" | "holdout"`.
  - `type SecretCase = { id: string; type: string; set: CorpusSet; secret: string; text: string; accepts: string[] }` — `secret` is `parts.join("")`; `text` is `template` with `{{SECRET}}` replaced by the secret; `accepts` is the list of placeholder types that count as correct (defaults to `[type]`).
  - `type InjectionCase = { id: string; family: string; set: CorpusSet; field: InjectionField; text: string; expect: "flag" | "block" }` where `InjectionField` is `"prose" | "evidence_prompt" | "evidence_trace"`.
  - `type CleanCase = { id: string; set: CorpusSet; field: InjectionField | "evidence_other"; text: string; note?: string; allowAltered?: boolean }`.
  - `loadSecrets(): SecretCase[]`, `loadInjections(): InjectionCase[]`, `loadClean(): CleanCase[]`.
- File formats: secrets entries `{ id, type, set, parts: string[], template: string, accepts?: string[] }`; injections entries `{ id, family, set, field, text, expect }`; clean entries `{ id, set, field, text, note?, allowAltered? }`. Unicode tricks are written as `\u` escapes inside the JSON so the files stay plain ASCII.

**Corpus requirements** (the test enforces counts and coverage; the builder authors the data):
- **Secrets:** at least 60 entries covering at least these 29 types: `aws_access_key`, `aws_secret_key`, `github_token`, `github_fine_grained`, `openai_key`, `anthropic_key`, `stripe_key`, `slack_token`, `slack_webhook`, `google_api_key`, `google_oauth`, `twilio_key`, `sendgrid_key`, `npm_token`, `huggingface_token`, `gitlab_token`, `telegram_bot_token`, `azure_storage_key`, `jwt`, `bearer_token`, `basic_auth_url`, `private_key`, `ac_api_key`, `generic_secret`, `email`, `phone`, `card`, `ssn`, `high_entropy`. Each type has at least 1 entry and `generic_secret`, `high_entropy`, `email`, `phone`, `card` have at least 2. Templates vary: `.env` lines, JSON bodies, curl commands, stack traces, YAML, URLs, markdown, log lines. At least 6 evasion entries (zero-width split, fullwidth letters, uppercase/lowercase variants, secret across a PEM line break, secret inside an escaped JSON string, secret next to a UUID).
- **Injections:** at least 60 entries in at least 8 families: `override`, `role_marker`, `tool_call`, `exfiltration`, `base64`, `hidden_unicode`, `scheme_and_beacon`, `combined`. At least 10 entries expect `block` (several strong signals together); at least 5 use hidden Unicode (tag characters, bidi overrides, zero-width); at least 8 are tool-call payloads; at least 6 are written in `evidence_prompt` or `evidence_trace` fields.
- **Clean:** at least 120 entries: tool errors, stack traces (several languages), JSON payloads, prompt excerpts, logs, tool schemas, plain prose, non-English text, emoji. At least 20 are near misses: ordinary text containing words like "ignore" or "system prompt" without any instruction, UUIDs, 40-character SHAs, `sha256:` digests, IP addresses, timestamps, semantic versions, example-domain emails, long identifiers, short base64, a prompt excerpt that starts "You are a helpful assistant".
- Every entry has `set` of `dev` or `holdout`; `holdout` is at least 30% of each corpus and is spread across all types and families.

- [ ] **Step 1: Write the validator test** (`tests/unit/corpus.test.ts`): counts per corpus; coverage of every required type and family; every entry has `dev` or `holdout`, ids are unique, `holdout` share is at least 30% overall and each required type or family has at least one holdout entry where it has three or more entries; every secret's `text` contains its `secret` exactly once and `secret.length >= 8`; clean texts are non-empty; **raw-file scan**: the raw text of `secrets.json` matches none of these literal-secret patterns: `ghp_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`, `AKIA[0-9A-Z]{16}`, `sk-[A-Za-z0-9_-]{20,}`, `sk_live_[A-Za-z0-9]{10,}`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `AIza[0-9A-Za-z_-]{30,}`, `SG\.[A-Za-z0-9_-]{16,}`, `glpat-[A-Za-z0-9_-]{15,}`, `hf_[A-Za-z0-9]{30,}`, `npm_[A-Za-z0-9]{30,}`, `eyJ[A-Za-z0-9_-]{10,}\.eyJ`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`; no file contains a non-ASCII byte.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/corpus.test.ts`. Expected: FAIL (files are empty).
- [ ] **Step 3: Implement** `tests/helpers/corpus.ts`, then author the three corpora in separate paste blocks (secrets, injections, clean traces). Clean traces must not be written to pass the gate by construction: include realistic noise a debugging agent produces.
- [ ] **Step 4:** Run the file, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `test: N4 fixture corpora and loader (AC-401)`.

---

### Task 2: Normalization and field limits (AC-402)

**Files:** Create `lib/safety/normalize.ts`, `lib/safety/limits.ts`, `lib/safety/thresholds.ts` (limits table values come from `LIMITS` in constants); Modify `lib/safety/gate.ts` (add `GateContext`); Test `tests/unit/normalize.test.ts`, `tests/unit/limits.test.ts`.

**Interfaces:**
- `type Stripped = { zeroWidth: number; bidi: number; tag: number; control: number }`.
- `normalizeText(input: string): { text: string; stripped: Stripped }` — NFKC; removes zero-width (U+200B to U+200D, U+2060, U+FEFF, U+00AD soft hyphen), bidi controls (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069, U+061C), tag characters (U+E0000 to U+E007F), and other control characters except `\n` and `\t`; converts `\r\n` and lone `\r` to `\n`; keeps variation selector U+FE0F and U+FE0E; counts what it removed in `stripped`.
- `type FieldKind = "prose" | "evidence_prompt" | "evidence_trace" | "evidence_other" | "tag" | "short"`.
- `type GateContext = { evidenceKind?: "trace" | "prompt" | "tool_schema" | "error" }`; `GateInput` gains `context?: GateContext` (optional, backwards compatible).
- `describeField(target: GateTarget, name: string, context?: GateContext): { limit: number; kind: FieldKind }` — table: case `title` 200 prose, `summary` 4000 prose, `expected` and `actual` 2000 prose, `environment.model` and `environment.framework` 80 short, `environment.framework_version`, `environment.language`, `environment.os` 40 short, `environment.tools.<n>` 60 short, `environment.notes` 500 prose, `tag.<n>` 32 tag; evidence `text` 32000 with kind `evidence_prompt` for evidence kind `prompt`, `evidence_trace` for `trace`, otherwise `evidence_other`; argument `reasoning` and `proposed_change` 8000 prose. Any other target or field name throws `Error("unknown gate field")` (no field name in the message).

- [ ] **Step 1: Write failing tests.** normalize: fullwidth `ＡＢＣ１２３` becomes `ABC123`; ligature `ﬁ` becomes `fi`; text `sk​-abc` becomes `sk-abc` with `zeroWidth: 1`; each of the other zero-width and soft-hyphen characters is removed and counted; bidi controls counted; tag characters (built with `String.fromCodePoint(0xE0041)`) removed and counted in `tag`; control characters `\u0000`, `\u0007`, `\u001b` removed, `\n` and `\t` kept; `\r\n` and `\r` become `\n`; emoji with U+FE0F survive; accented Latin, CJK, Arabic, Cyrillic and Hebrew text is unchanged except for NFKC-equivalent forms; an empty string, whitespace, and a string of only hidden characters return `""`/unchanged whitespace without throwing; running `normalizeText` twice is the same as once. limits: every row of the table; `evidence_prompt`/`evidence_trace`/`evidence_other` by context (missing context gives `evidence_other`); unknown field and unknown target throw, and the error message contains no field name.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Thresholds file starts with the numbers this node defines (leave later ones to their tasks): `INJECTION_FLAG_SCORE = 3`, `INJECTION_BLOCK_SCORE = 9`, `REDACTION_BLOCK_RATIO = 0.5`, `PROMPT_EVIDENCE_WEIGHT = 0.5`.
- [ ] **Step 4:** Run both files, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 normalization and field limits (AC-402)`.

---

### Task 3: Pattern catalogue (AC-403, part)

**Files:** Create `lib/safety/patterns.ts`; Test `tests/unit/patterns.test.ts`.

**Interfaces:**
- `type PatternRule = { type: string; regex: RegExp; group?: number; validate?: (matched: string) => boolean }` — `regex` has the `g` flag; when `group` is set, only that capture group is the secret (the surrounding text such as `password=` is kept); `validate` rejects false positives (used for cards).
- `PATTERNS: readonly PatternRule[]` — one or more rules for each of these types: `aws_access_key`, `github_token`, `github_fine_grained`, `openai_key`, `anthropic_key`, `stripe_key`, `slack_token`, `slack_webhook`, `google_api_key`, `google_oauth`, `twilio_key`, `sendgrid_key`, `npm_token`, `huggingface_token`, `gitlab_token`, `telegram_bot_token`, `azure_storage_key`, `jwt`, `bearer_token`, `basic_auth_url`, `private_key` (the whole PEM block, header to footer, including a block cut off before its footer at the end of the text), `ac_api_key` (`ac_live_` and `ac_test_` followed by 8 or more base62 characters), `email`, `phone`, `card`, `ssn`.
- `luhnValid(digits: string): boolean`.
- `EMAIL_ALLOWED_DOMAINS: readonly string[]` — `example.com`, `example.org`, `example.net`, `localhost`, and any domain ending `.example`, `.test`, `.invalid`, `.localhost`.

- [ ] **Step 1: Write failing tests.** One test per type using values built from joined parts in the test (never one literal): the secret is matched in full by exactly one rule of that type, inside a surrounding sentence, and the characters around it are not matched. Negative tests per family (a shorter or malformed lookalike is not matched, for example `ghp_` followed by 5 characters, `AKIA` followed by lowercase). `card`: a Luhn-valid 16-digit number with spaces or dashes matches; a 16-digit number failing Luhn does not; 13- and 19-digit valid numbers match; a 10-digit phone-like number is not a card. `phone`: E.164 (`+14155550100`), US formats (`(415) 555-0100`, `415-555-0100`), and international with spaces match; version strings `1.2.3.4`, dates `2026-10-24`, and 8-digit numbers do not. `email`: ordinary addresses match; example-domain addresses (`a@example.com`, `a@x.test`) are listed as allowed (a helper `isAllowedEmailDomain` or the validator rejects them). `ssn`: `123-45-6789` matches, `000-12-3456`, `666-12-3456` and `123-00-4567` do not. `private_key`: a multi-line block and a header-only truncated block both match to the end of the text. `jwt`: three dot-separated base64url parts, the first starting `eyJ`. **Speed:** each regex runs over 32,000 characters of `a`, of `1`, of `=`, of `-`, of `A-` repeated, of `@`, and of `ac_live_` repeated, within 500 ms.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Regexes use bounded quantifiers and anchors on literal prefixes so they are linear; compile once at module load.
- [ ] **Step 4:** Run the file, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 secret pattern catalogue (AC-403)`.

---

### Task 4: Redaction engine (AC-403, AC-404)

**Files:** Create `lib/safety/redact.ts`; add entropy numbers to `lib/safety/thresholds.ts`; Test `tests/unit/redact.test.ts`.

**Interfaces:**
- `type RedactionItem = { type: string; start: number; length: number }` — position and length in the input text, never the matched text.
- `redactText(text: string): { text: string; items: RedactionItem[] }` — applies, in this order: pattern rules (`PATTERNS`), context rules, high-entropy tokens; then resolves overlaps (earliest start wins, then the longest), replaces each match with `[REDACTED:<type>]`, and returns items sorted by `start`. Idempotent: redacting the output again changes nothing.
- **Context rules** (type `generic_secret`): a name matching `password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|authorization|credential|private[_-]?key|client[_-]?secret` (case-insensitive, optionally prefixed or suffixed by word characters, quotes or `\"`), followed by `=` or `:` (with optional spaces and quotes), redacts the value up to the next whitespace, quote, comma, semicolon, `&`, or closing bracket. Only the value is redacted, so the key name stays readable. This covers `KEY=value`, `key: value`, `"key": "value"` and `\"key\": \"value\"` without parsing JSON (formatting is preserved).
- **High-entropy tokens** (type `high_entropy`): a token of at least 24 characters from `[A-Za-z0-9+/_=-]` that contains both a letter and a digit and has Shannon entropy at least 4.2 bits per character; or a hexadecimal token of at least 32 characters with entropy at least 3.0. Tokens containing `/` or a file extension that look like paths (two or more `/` separated segments with dots) are skipped. Numbers go in `thresholds.ts`.
- **Allowlist** (never redacted by the entropy rule; also skipped by context rules only when the value is exactly one of these): UUIDs, 40-character lowercase hex git SHAs, tokens preceded by `sha256:`, `sha256-`, `sha512-` or `sha1:`, and 7 to 12 character short SHAs (too short to match anyway).
- `redactedRatio(text: string, items: RedactionItem[]): number` — characters covered by items divided by `text.length` (0 for empty text).

- [ ] **Step 1: Write failing tests.** Every pattern type is redacted inside a larger text and the placeholder carries the type; `password=hunter2` becomes `password=[REDACTED:generic_secret]`; JSON `{"api_key": "abc"}` becomes `{"api_key": "[REDACTED:generic_secret]"}` with the quotes and braces kept; escaped `\"token\": \"abc\"` works; `Authorization: Bearer <token>` redacts the token as `bearer_token` and keeps the header name; a 64-character hex string next to the word `secret` is redacted, the same string alone after `sha256:` is not; a UUID, a 40-character git SHA and a `sha256:` digest survive; a 32-character random token with letters and digits is redacted as `high_entropy`; an English sentence, a long camelCase identifier (`getUserAccountPreferencesFromRepository`), a dotted package path and a file path of 60 characters are not; `a@example.com` survives and `person@company.io` is redacted as `email`; two overlapping matches (a URL with credentials containing a token) produce one placeholder; idempotence; **report invariants** (a property test over every pattern value and over joined secrets from the corpus dev set): `JSON.stringify(items)` does not contain the secret, each item's `start` and `length` select exactly the removed span in the input, and items never overlap; `redactedRatio` of fully redacted input is 1 and of untouched input is 0; empty and whitespace input return unchanged; **speed**: 32,000 characters each of `a`, `a1` repeated, `=`, `password=` repeated, `A-` repeated and random-looking base64 finish within 500 ms.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement** with single-pass scanning per rule and a merge step; compute entropy on the token only.
- [ ] **Step 4:** Run the file, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 redaction engine (AC-403, AC-404)`.

---

### Task 5: Injection scorer (AC-405)

**Files:** Create `lib/safety/injection.ts`; Test `tests/unit/injection.test.ts`.

**Interfaces:**
- `type InjectionHit = { rule: string; count: number; weight: number }`.
- `scoreInjection(text: string, options: { kind: FieldKind; stripped?: Stripped }): { score: number; hits: InjectionHit[] }` — the score is the sum over rules of `weight × min(count, 3)`; for kinds `evidence_prompt` and `evidence_trace`, the `role_marker` and `override` families are multiplied by `PROMPT_EVIDENCE_WEIGHT` (0.5); hidden characters in `stripped` add a `hidden_unicode` hit: tag characters weight 6 (a flag on their own, a block together with any other strong signal), bidi overrides weight 3, zero-width characters weight 1 (at least 5 of them add the weight once). Rules match on a **homoglyph-folded** copy of the text: a small table maps common Cyrillic and Greek lookalike letters (for example U+043E, U+0435, U+0430, U+0440, U+0441, U+0399, U+03A1, U+039F) to Latin before matching; NFKC alone does not fold them.
- `INJECTION_RULES: readonly { id: string; family: string; weight: 1 | 2 | 3; regex: RegExp }[]` — families `override`, `role_marker`, `tool_call`, `exfiltration`, `base64`. Strong (weight 3): explicit override phrases ("ignore (all )?(the )?(previous|prior|above|earlier) (instructions|prompts|messages)", "disregard ... instructions", "forget everything"), tool-call payload markers (`<function_calls>`, `<invoke name=`, `"tool_calls"`, `<tool_use>`), exfiltration (`curl ... | sh`, "send (me |us )?(your|the) (api key|token|credentials|secrets|environment)", `cat .env`, "reveal your (system )?prompt"). Medium (weight 2): `you are now`, "new instructions:", "act as (an? )?(admin|system|developer|root)", "do not tell the user", role markers at a line start (`system:`, `assistant:`, `<|im_start|>`, `[INST]`, `<<SYS>>`, `### Instruction`). Weak (weight 1): "system prompt", "jailbreak", "developer mode". Base64: a run of 200 or more base64 characters (not preceded by `sha256-` or `sha512-`) is weight 2.
- Matching is case-insensitive and tolerant of extra whitespace and of repeated punctuation between words, over the already-normalized text.

- [ ] **Step 1: Write failing tests.** One test per rule family with several phrasings each (including line-break and extra-space variants and different case); weights add up as specified (`ignore previous instructions` alone scores 3; adding a tool-call marker scores 6; three strong signals reach 9); the count cap (ten repeats of one weak phrase scores at most 3); `prompt`/`trace` evidence halves override and role-marker scores while exfiltration and tool-call scores stay at full weight; `stripped.tag > 0` yields a `hidden_unicode` hit of weight 6 (score 6 alone, 9 with one more strong signal); Cyrillic and Greek lookalike spellings of `ignore previous instructions` score the same as the Latin spelling; bidi and zero-width rules; **no false positives** on: "ignore the previous error in the log and retry", a neutral discussion mentioning the phrase "system prompt" once (score at most 1), "you are a helpful assistant" in a prompt excerpt (score 0), ordinary Spanish, Chinese, Arabic and Russian prose, JSON that contains the word `name` and `arguments` without tool-call markers, a 150-character base64 string, and a 64-character hex digest; empty and whitespace input score 0; **speed**: 32,000 characters each of `a`, `ignore ` repeated, `you are ` repeated, `<` repeated and `\n` repeated finish within 500 ms.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement** the rule table; compile once; stop counting a rule after the cap to keep matching cheap.
- [ ] **Step 4:** Run the file, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 injection scorer (AC-405)`.

---

### Task 6: Link scan (AC-406)

**Files:** Create `lib/safety/links.ts`; Test `tests/unit/links.test.ts`.

**Interfaces:**
- `type LinkScan = { total: number; dangerous: Record<string, number>; beacons: number }`.
- `scanLinks(text: string): LinkScan` — counts `http(s)://` links in `total`; counts `javascript:`, `vbscript:`, `data:text/html`, `data:application`, `file:` and `ftp:` URLs per scheme in `dangerous`; counts markdown images with a remote URL (`![...](http...)`) and HTML `<img` / `<iframe` / `<script` / `<link` / `<object` tags in `beacons`.
- `linkScore(scan: LinkScan): number` — 3 per dangerous scheme occurrence (capped at 9) plus 2 per beacon (capped at 6).
- The module never rewrites text and never makes a network call.

- [ ] **Step 1: Write failing tests.** Counting for plain links, links in markdown, several links in one line; each dangerous scheme counted under its own key; case-insensitive (`JavaScript:`); beacon forms; `linkScore` caps; ordinary text, an email address and `file.txt` score 0; the text returned by any other function is untouched (this module returns counts only); **no network**: install a spy on `globalThis.fetch` and start a local `node:http` server, run `scanLinks` over text containing that server's URL, assert zero requests were recorded and the spy was never called; a source-scan test reads every file in `lib/safety/` and fails if any contains `fetch(`, `node:http`, `node:https`, `node:net`, `XMLHttpRequest` or `import("http`; speed over 32,000 characters of `http://` repeated and of `![` repeated within 500 ms.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the file, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 link scan (AC-406)`.

---

### Task 7: Gate engine and version (AC-407)

**Files:** Create `lib/safety/engine.ts`, `lib/safety/version.ts`; Modify `lib/safety/gate.ts` (`screenSafely` logs the error class); Test `tests/unit/engine.test.ts`, extend `tests/unit/gate.test.ts`.

**Interfaces:**
- `GATE_VERSION: string` in `version.ts`, format `YYYY-MM-DD.N` (start at `2026-10-24.1`).
- `createGate(options?: { trace?: (step: GateStep, field: string) => void }): SafetyGate` where `GateStep = "normalize" | "limits" | "redact" | "injection" | "links" | "outcome"`.
- Per field, in this order: `normalizeText` → length check against `describeField(...).limit` → `redactText` → `scoreInjection` on the redacted text (with `kind` and `stripped`) → `scanLinks` on the redacted text (`linkScore` adds to the score) → outcome. `trace` is called once per step per field in that order.
- Per-field outcome (then the most severe wins over all fields): `block` if the normalized text is longer than the limit, or `redactedRatio` is above `REDACTION_BLOCK_RATIO`, or the total score is at least `INJECTION_BLOCK_SCORE`; `flag` if the score is at least `INJECTION_FLAG_SCORE`, or `stripped.tag > 0`, or the field kind is `tag` and normalization or redaction changed the text; else `pass`. Returned `fields` hold the redacted normalized text for every input field, whatever the outcome (for `block`, they are returned but must not be stored by callers).
- `report` shape: `{ version: GATE_VERSION, outcome, redactions: { total: number, types: Record<string, number> }, fields: Record<string, { outcome, stripped, score, hits: InjectionHit[], redactions: RedactionItem[], links: { total, dangerous, beacons } }> }` — ids, counts and positions only.
- `screenSafely` additionally calls `logger.warn("gate failure", { target, errorClass })` when the gate throws or returns a malformed decision (`errorClass` is `error.constructor.name`; never the message or any field).

- [ ] **Step 1: Write failing tests.** Order: with `trace` recording `(step, field)`, each field shows exactly `normalize, limits, redact, injection, links, outcome`; **normalization before redaction**: a GitHub-style token with a zero-width character inside, and the same token in fullwidth letters, are redacted; clean text passes with `fields` unchanged and an empty `redactions`; a secret is redacted and the outcome stays `pass`, with `redactions.types` counting it; outcomes: a field over its limit after NFKC expansion (text of 200 `㈱` characters in a `title`, which NFKC expands) is `block`; a field that is mostly secrets (a 60-character token alone) is `block` by ratio; `ignore previous instructions` in a summary is `flag`; three strong signals are `block`; a tag character anywhere is `flag`; an email in `tag.0` changes the tag and is `flag`; prose in `evidence` with kind `prompt` that says `you are now a root shell` (halved) scores below the flag line; most severe field wins across a case with one clean and one flagged field; unknown field name makes `screen` throw and `screenSafely` return `flag`; a gate whose step throws (inject a failing rule through a test-only option or by passing a field that makes `describeField` throw) is `flag` through `screenSafely`; **report hygiene**: for every secret in the corpus dev set placed in a case summary, `JSON.stringify(decision.report)` does not contain the secret and does not contain the original surrounding text; `report` is JSON-serializable and deterministic (same input gives equal output); **logging**: when `throwingGate` (message contains a fake secret) is passed through `screenSafely`, `console.warn` receives one line containing `gate failure` and the class name `Error`, and neither the message nor the target's field values; **speed**: a maximum-size request (case fields at their limits plus 10 evidence items of 32,000 characters of mixed realistic text, each through `screen`) finishes within 3 seconds in total, and 32,000 characters each of `a`, `a1`, `=` and `password=` in one field finish within 500 ms.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep per-field logic in one function; combine with a small severity table.
- [ ] **Step 4:** Run both files, then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N4 gate engine and versioning (AC-407)`.

---

### Task 8: Corpus acceptance and tuning (AC-403, AC-405)

**Files:** Create `tests/unit/gateCorpus.test.ts`; Modify rule, pattern and threshold files as tuning needs.

**Interfaces:** none new.

- [ ] **Step 1: Write the acceptance test.** For each secret entry, run `createGate().screen` on a case with `summary = entry.text` (and evidence entries as `evidence` where the template looks like a trace): the secret string does not appear in any returned field or in `JSON.stringify(report)`, and at least one placeholder whose type is in `entry.accepts` is present. Assertions per set: secrets redacted at least 98% for `dev` and for `holdout` (the failing entry ids are printed, never the secrets); every injection entry (both sets) ends `flag` or `block`, `block` entries end `block`; clean entries: fewer than 5% flagged or blocked and at most 2% altered by redaction, separately for `dev` and `holdout` (entries with `allowAltered: true` are excluded from the altered count); the `holdout` results are printed as one summary line per corpus (counts only).
- [ ] **Step 2:** Run it. Expected: some failures on the first run.
- [ ] **Step 3: Tune on `dev` only.** Fix patterns, rules and thresholds using failures from `dev` entries. Look at `holdout` failures only as counts. If a holdout entry exposes a real gap, add the missing coverage as a new `dev` entry first, fix the rule, and keep the original entry in `holdout`.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Expected: PASS. Record the final numbers (secrets, injections, clean flagged, clean altered, each for `dev` and `holdout`) in the commit message.
- [ ] **Step 5:** Mark AC-401 to AC-407 done in `docs/ticket.md`; update `docs/directory.md` section 7.3 (the orchestrator is `engine.ts`; the interface stays in `gate.ts`).
- [ ] **Step 6: Commit** `feat: N4a gate engine meets corpus targets (AC-401 to AC-407)`.

---

## Self-review notes

- **Spec coverage:** gate interface and context (Task 2, 7), screened fields and limits (2, 7; wiring is N4b), normalization and tag characters (2), redaction families, context rules, entropy, allowlist, report (3, 4), injection families and half weights (5), links (6), outcome rules and block at 9 (7), versioning (7), corpora with holdout and parts (1, 8), speed budgets (3 to 7). Not in N4a by design: wiring, `redactions` in responses, `rejected` statuses and migration, admin queue, re-scan, `check:routes`, lifting the production block (all N4b).
- **Deviation from the plan text:** "structured evidence (JSON) is walked field by field" is implemented as key-aware context rules over the raw text, which preserves the author's formatting and avoids re-serialising; the effect (a key named `password` redacts its value) is the same.
- **Overfitting risk:** the same author writes corpora and rules. The `holdout` split limits it; a human reviewer should add strings the author did not think of before launch.
- **Type consistency:** `FieldKind`, `Stripped`, `RedactionItem`, `InjectionHit`, `GateContext`, `GateStep` are each defined once (Tasks 2, 2, 4, 5, 2, 7) and used by name later.
