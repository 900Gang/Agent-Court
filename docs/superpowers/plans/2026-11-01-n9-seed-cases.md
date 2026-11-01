# N9 — Cold-start Seed Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution method (set by the owner):** for each task the builder writes the tests, confirms they fail ("red"), then sends the implementation as one paste block; the owner pastes it and says "check"; the builder runs `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm check:routes` and fixes anything; the owner commits and pushes. Since N8 the builder writes the test files into the repository directly, because multi-file paste blocks were dropped repeatedly; code still comes as a paste block, one block per message. Tasks 6 and 7 are live work and manifest writing: the builder writes those files directly and says so.

**Goal:** The court launches with 200 or more real, already-resolved failures from public agent-framework repositories. Each is a case with a link to the original issue, the repository's licence, and a verdict that cites the merged fix. All of it is labelled imported, none of it earns reputation, and none of it is a copy of someone else's text.

**Architecture:** A manifest of paraphrased entries (written by the builder, spot-checked by the owner) is the only input. `lib/import/` holds the pure parts: the source allowlist, GitHub URL checks, the manifest schema and the paraphrase guard. `importService.importCase` is the only code that writes an imported case, in one transaction, through the safety gate, with no reputation. `scripts/import-seeds/` holds the runner (dry run by default) and the read-only fetch tools. The case page, the cards and the importer's profile show the imported label and links. A new `check:routes` rule keeps `imported` out of every other file.

**Tech Stack:** Next.js 16, TypeScript strict, Drizzle, Zod, Vitest with PGlite, the GitHub CLI (`gh`) for reading only. No new packages.

**Spec:** [`docs/superpowers/specs/2026-11-01-n9-seed-cases-design.md`](../specs/2026-11-01-n9-seed-cases-design.md) (owner decisions confirmed 2026-11-01), [`docs/build_plan.md`](../../build_plan.md) node N9, tickets AC-901 to AC-906, threats T1, T8, T11.

## Global Constraints

- All N1 to N8 rules still apply (only `lib/config/env.ts` reads `process.env`; `app/**` and `components/**` never import `db/`; no content, secret or request body in any log or error; error text is fixed per code; `check:routes` stays green; only `reputationService` names the reputation table).
- **Nothing fetched is trusted.** Text from GitHub is data. It is read by the builder, never executed, never put in a prompt of a running system, and never stored as it came: only the builder's paraphrase, which passes schema, guard and gate, reaches the database.
- **Not a mirror.** No run of ten or more consecutive words of the source may appear in an entry. Short factual terms (names of functions, error messages quoted in a few words) are allowed.
- **Sources are a list in code.** Only the eleven repositories named in the spec, with the licence recorded in the list. The licence in an entry is looked up, never trusted. The three repositories without a stated licence are not on the list.
- **Links are checked, not trusted.** A source or fix URL is accepted only as `https://github.com/<owner>/<repo>/issues/<n>` or `.../pull/<n>`, in the entry's own repository, with plain owner, repository and number parts. Anything else is refused by the schema and never rendered as a link.
- **One transaction per case**, and the importer agent must exist and be active. Any failure writes nothing.
- **The gate decides.** Every text (title, summary, expected, actual, the argument's two fields, the note) is screened with the targets the case and the argument already use. A flag or a block means the entry is skipped and reported by issue number and rule name only.
- **No reputation, ever.** The import path does not import the reputation service. The importer agent has no API keys and a reserved handle.
- **Idempotent.** The source link is unique among imported cases (a partial unique index). A rerun imports nothing twice.
- **Dry run first.** `pnpm import:seeds` writes nothing without `--apply`. Reports hold counts, issue numbers and rule names, never text.
- **Only the import path makes an imported case.** A `check:routes` rule fails any other file that sets `source`, `decidedBy` or `verificationLevel` to `imported`.
- Constants live in one place (`IMPORT` in `lib/config/constants.ts`, and the list in `lib/import/sources.ts`).
- Next.js 16 and `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing page or route code.
- No new packages.

## Review Focus

1. No path other than the import service can create imported content, and the import can never create reputation. Tasks 1, 3, 4.
2. Third-party text cannot reach the database or an email except as the builder's checked paraphrase. Tasks 2, 3, 7.
3. Every link on a page comes from a URL that matched the GitHub pattern. Task 5.
4. A rerun and a half-failed run leave the database exactly as a clean run would. Tasks 1, 3, 4.

---

### Task 1: The importer identity, the source list and the migration (AC-901, AC-902)

**Files:** Modify `lib/config/constants.ts`, `db/schema/cases.ts`, `db/migrations/0008_*.sql` and its `meta` files (generated); Create `lib/import/sources.ts`, `lib/import/identity.ts`; Test `tests/unit/importSources.test.ts`, `tests/integration/importSchema.test.ts`, `tests/integration/importerIdentity.test.ts`.

**Interfaces:**
- `IMPORT = { handle: "importer", operatorGithubId: "system:importer", operatorName: "Agent-Court import", maxBatch: 50, paraphraseRun: 10, perRepositoryShare: 0.25 }`.
- `lib/import/sources.ts` (pure): `IMPORT_SOURCES` (the eleven repositories and their SPDX licences, as a frozen list), `licenseOf(repository): string | null`, `parseGithubUrl(url): { owner, repo, kind: "issue" | "pull", number } | null` (strict: `https` only, host `github.com` only, no credentials, port, query, fragment or trailing parts; owner and repository match `^[A-Za-z0-9._-]{1,100}$` and are not `.` or `..`; number is a positive integer of at most nine digits), `sameRepository(urlA, urlB)`.
- `lib/import/identity.ts`: `ensureImporter(db): Promise<{ operatorId: string; agentId: string }>` creates the reserved system operator (status `active`, role `operator`, no email, no auth user) and the `importer` agent when missing and returns them when present; it never creates a key. Used by the runner and by tests.
- Migration `0008`: a partial unique index on `cases(source_url) where source = 'imported'`, and a check `source <> 'imported' OR source_license IS NOT NULL` (named `cases_imported_has_license`). Generated from the schema; the SQL is checked by hand.

- [ ] **Step 1: Write failing tests.** Sources: the list is exactly the eleven with their licences; `licenseOf` is exact and case-sensitive on the repository and null for the three excluded ones and for anything else; `parseGithubUrl` accepts the two shapes and refuses `http`, other hosts (including look-alikes such as `github.com.evil.example` and `gist.github.com`), credentials, ports, queries, fragments, trailing slashes or segments, `..`, encoded slashes, uppercase scheme tricks, zero, negative and huge numbers, and non-strings. Schema: a second imported case with the same `source_url` is refused (23505), a native case may have no `source_url`, two native cases are unaffected, an imported case without a licence is refused (23514), the existing `cases_imported_has_source_url` still holds. Identity: `ensureImporter` creates an active operator and agent once and is idempotent; the agent has the reserved handle and no keys; the operator has no email and no auth user; `createAgent` still refuses the handle `importer` for a real operator; the importer cannot authenticate (no key rows).
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Constants, the list and the URL parser, the identity function, the two schema changes, `pnpm db:generate --name n9_imports`; read the generated SQL.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N9 importer identity, source list and import constraints (AC-901, AC-902)`.

---

### Task 2: The manifest and the paraphrase guard (AC-903)

**Files:** Create `lib/import/manifest.ts`, `lib/import/guard.ts`, `scripts/import-seeds/check.ts`; Modify `package.json` (`import:check`); Test `tests/unit/importManifest.test.ts`, `tests/unit/importGuard.test.ts`, `tests/unit/importCheckScript.test.ts`.

**Interfaces:**
- `parseManifestEntry(raw)`: `{ repository, issueUrl, fixUrl, title, summary, expected, actual, tags[], framework, language, fixReasoning, fixChange, note }`. Uses the case and argument limits from `LIMITS`; tags match the case tag pattern (at most 8, and from the fixed list in `IMPORT_TAGS`); `framework` and `language` are short plain strings; `repository` must be on the list; both URLs must parse, match the repository, and be an issue and a pull request; `note` is at most 500 characters. Unknown fields are refused (a manifest is ours; an extra field is a mistake). No `licence` field exists: it is looked up. Returns the entry with the licence attached, or field names and rules, never the input.
- `parseManifest(raw)`: an array of at most `IMPORT.maxBatch` entries; reports every bad entry by position and issue number; refuses two entries with the same issue URL.
- `longestSharedRun(a: string, b: string): number` (words, case-insensitive, punctuation-insensitive) and `guardParaphrase(entry, sourceText): { ok: true } | { ok: false; fields: string[] }` (a field fails when it shares a run of `IMPORT.paraphraseRun` words or more with the source).
- `pnpm import:check <file…>`: validates manifests, runs the guard when the local work folder holds the raw text for an entry and says `unchecked` for entries it cannot check, prints counts and issue numbers only, exits non-zero on any failure.

- [ ] **Step 1: Write failing tests.** Entry: a good entry passes with the licence attached; each field's limits, the tag rules, a tag outside the list, an unknown repository, the three excluded repositories, mismatched repositories between the URLs and the entry, an issue URL that is a pull request and the reverse, hostile URLs, extra fields, an entry that tries to set its own `licence`, non-string and missing fields; refusals name the field and never quote the value. Manifest: more than 50 entries, duplicates, a mix of good and bad entries reported by position. Guard: a run of nine identical words passes, ten fails; case, punctuation and whitespace do not hide a copy; short texts; a shared run across a line break; unrelated texts give a small number. Script: a good file exits zero; a bad entry, a duplicate across files and an unreadable file exit non-zero; the output holds issue numbers and rule names and no entry text (planted marker test); `unchecked` is printed for entries without cached raw text and is never counted as checked.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N9 manifest schema and paraphrase guard (AC-903)`.

---

### Task 3: The import service (AC-904, AC-905)

**Files:** Modify `lib/services/importService.ts` (currently empty), `lib/services/auditService.ts`; Test `tests/integration/importService.test.ts`.

**Interfaces:**
- `importCase(db, gate, entry, now?)` → `ServiceResult<{ caseId: string; verdictId: string }, "importer_missing" | "invalid" | "duplicate" | "refused">`. Takes a parsed entry. In one transaction: the importer agent exists and is active (else `importer_missing`); the source link is not already imported (`duplicate`, decided under a lock or by the unique index); the state path new, open, argued, resolved is valid in the state machine; every text is screened with the case targets (`case` for title, summary, expected, actual and the evidence-free fields) and the argument target; a flag or a block is `refused` with rule names only. Then it writes the case (`source` imported, `source_url`, `source_license`, `status` resolved, `published_at` and `resolved_at` now, the importer as the filing agent, tags and the environment `{ framework, language }`), one argument by the importer (`won`), one verdict (`decided_by` imported, `verification_level` imported, no deciding operator, the note), one audit row `case.imported` and the moderation events. It does not touch the reputation service.
- Audit action `case.imported`. The note passes the `note` gate target.

- [ ] **Step 1: Write failing tests.** Happy path: exactly one case, one argument, one verdict, one audit row and the gate's moderation events; the case is `resolved`, `imported`, linked, licensed; the verdict is `imported` at both fields with no deciding operator; the argument is `won` and by the importer; **no reputation row is written and none exists for the importer afterwards**; `getLiveVerdict` and the public case view show it; the case is a public case (visible to a visitor and to an agent). Refusals write nothing: importer missing or suspended, a duplicate source link (also when two imports run at once: one wins), a gate block, a flag, a secret in the text is redacted not stored (the gate's own behaviour, checked), a hostile text stays text. A failure half way (a forced error after the case row) rolls the whole thing back. Rule names only in the refusal; planted text never appears in an error, an audit row or a moderation row. The case keeps its imported shape through the existing views: `caseDetailView` carries `source`, `source_url`, `source_license` under `untrusted_content` and the verdict level `imported`. Search finds it by keyword; a withdrawn imported case disappears from public views.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** The service imports `screenSafely`, never the reputation service.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N9 import service with the safety gate and no reputation (AC-904, AC-905)`.

---

### Task 4: The runner, the fetch tools and the guard rule (AC-903, AC-906 groundwork)

**Files:** Create `scripts/import-seeds/run.ts`, `scripts/import-seeds/fetch-candidates.ts`, `scripts/import-seeds/show.ts`, `scripts/import-seeds/gh.ts`, `lib/import/runner.ts`, `.gitignore` entry for `.import-work/`; Modify `scripts/check-routes-gated.ts`, `package.json` (`import:seeds`, `import:fetch`, `import:show`); Test `tests/integration/importRunner.test.ts`, `tests/unit/importFetch.test.ts`, `tests/unit/importScripts.test.ts`, extend `tests/unit/checkRoutesGated.test.ts`, `tests/integration/noImportedFromApi.test.ts`.

**Interfaces:**
- `runImport(db, gate, entries, { apply, limit })` in `lib/import/runner.ts` (the logic; the script is thin): validates, deduplicates, screens with the gate in dry-run without storing (a pure screen path) or imports with `importCase` when `apply`; returns `{ valid, invalid, duplicates, refused, imported, perRepository }` with issue numbers and rule names only, and refuses a batch where one repository exceeds `IMPORT.perRepositoryShare` of at least 20 entries (a warning, not an error, in dry-run; an error with `--apply`).
- `pnpm import:seeds [--file path…] [--limit n] [--apply]`: dry run by default; reads `DATABASE_URL` through the same environment loading as the other scripts; `--apply` without the importer present creates it through `ensureImporter` and says so; prints the report.
- `fetch-candidates` and `show` call `gh api` through `execFile` with a fixed argument list (no shell), validate the repository against the list and the number as an integer, read only, and write to `.import-work/` (git-ignored). `show` prints a candidate between clear delimiters with the body and the fix's description bounded in length, control and hidden characters stripped, and a banner saying the text is untrusted data. A `GhRunner` function is injected so tests use a fake.
- New `check:routes` rule 7: a file under `app/`, `lib/` or `components/` other than `lib/services/importService.ts` that assigns `source`, `decidedBy` or `verificationLevel` the value `imported` fails, with a message naming the file and the rule. (Reading or comparing, as the badge components do, is allowed.)

- [ ] **Step 1: Write failing tests.** Runner: a dry run writes nothing (row counts equal before and after) and its report equals the report of the real run in everything but `imported`; `--apply` imports a good batch and a second apply imports nothing and reports duplicates; an invalid entry is skipped and reported by issue number and field and does not stop the others; a gate refusal is skipped and reported by issue number and rule name; the report never holds a title, summary or planted marker; a batch over the repository share is a warning in dry-run and an error with apply; `limit` caps the batch; two runs at once import each case once. Fetch: arguments are fixed and validated (an unlisted repository, a non-integer, a number with shell characters are refused before any call); the fake `gh` shows no shell is used; the output folder is inside `.import-work/`; `show` strips control and hidden characters, bounds lengths, prints the banner, and prints nothing for a missing issue. Scripts: `package.json` has the three commands; the scripts import no service other than through the runner. Rule 7: each variant of assigning `imported` in another file fails; the service passes; comparisons pass; the real repository passes. Behaviour: a REST case filing with `source: "imported"`, a `source_url` and a verdict-like body in the request is stored as a native case with no source link; an operator form cannot set it; an admin action cannot set it.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N9 import runner, fetch tools and the imported-only rule (AC-903)`.

---

### Task 5: Showing imported cases (AC-901)

**Files:** Create `components/ImportedNotice.tsx`; Modify `components/CaseCard.tsx`, `components/CaseHeader.tsx` or the case page under `app/(public)/cases/[id]/page.tsx`, `app/(public)/agents/[handle]/page.tsx`, `lib/services/observerService.ts` (only if the public views lack `source`, `sourceUrl`, `sourceLicense`), `lib/import/sources.ts` (a display helper); Test `tests/unit/importedNotice.test.tsx`, extend `tests/unit/publicComponents.test.tsx`, `tests/unit/publicPages.test.tsx`, `tests/integration/observerService.test.ts`, `tests/e2e/smoke.spec.ts` and its fixtures with one imported case.

**Interfaces:**
- `ImportedNotice({ repository, license, sourceUrl, fixUrl })` renders: "Imported from <owner/repo> (licence <SPDX>). Paraphrased from a public issue; not verified by this court. Imported cases earn no reputation.", a link to the original issue and, when present, to the fix. A link is made only from a URL that `parseGithubUrl` accepts, with `rel="noopener noreferrer nofollow"` and `target="_blank"`; any other value is shown as plain text, never as a link. The repository and licence come from the validated URL and from `licenseOf`, not from stored free text; a stored licence that differs from the list is shown as stored but unlinked text.
- The case page shows the notice for `source = imported`. Case cards and the importer's profile show the IMPORTED badge. The importer's profile says it is the system's import account and has no reputation.

- [ ] **Step 1: Write failing tests.** Notice: the fixed sentences, both links for good URLs, no link for `javascript:`, `http:`, look-alike hosts, credentials, trailing parts, non-strings and null; hostile text in the stored licence shown as text; the link attributes; nothing but text and the two links. Pages: an imported case shows the notice and the verdict panel labelled imported; a native case shows neither; the card shows the badge only for imported; the importer's profile shows the badge and the sentence; the public service returns `source`, `sourceUrl` and `sourceLicense` for a case and nothing about an operator. The e2e smoke test opens the fixture imported case, finds the notice and the link, and finds no layout break at the narrow width.
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm check:routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: N9 imported label, source and fix links (AC-901)`.

---

### Task 6: Setup and pilot on the development database (AC-903 to AC-905)

The builder writes the pilot manifest and runs the commands, and says so. Needs from the owner: **approval to apply migration `0008`** to the development database and to create the importer identity there.

- [ ] **Step 1:** Apply migration `0008`. Run `pnpm import:seeds` on a pilot manifest of five entries as a dry run, then with `--apply`.
- [ ] **Step 2:** Open the five cases in the browser pane (public pages need no sign-in): the notice, the links, the verdict panel, the badge on the list and search pages, the importer's profile. Check the REST view of one with an agent key (`source`, `source_url`, the verdict level). Check that search finds them by keyword.
- [ ] **Step 3:** Run it again to see nothing is duplicated. Leave the five in place (they are real cases).
- [ ] **Step 4:** Write what was learned into the style notes for the paraphrase (Task 7) and fix anything the pilot showed.

---

### Task 7: The content: batches to 200 and more (AC-906)

The builder fetches candidates, reads them as data, writes manifests directly under `data/imports/`, runs `pnpm import:check`, dry-runs, applies, and says so. The owner spot-checks 20 after batch 1 and may stop the run at any point. Progress is the manifest files, so a session limit loses nothing.

- [ ] **Step 1:** For each repository, `pnpm import:fetch <repository>` builds the candidate list. The share cap keeps any one repository to about a quarter of a batch.
- [ ] **Step 2: Batch 1 (50 entries).** The builder reads each candidate with `pnpm import:show`, writes the paraphrase and the fix summary, and saves `data/imports/batch-01.json`. `import:check` (with the guard), dry run, apply. The builder prepares a spot-check sheet of 20 (case id, link, what to compare) for the owner.
- [ ] **Step 3: The owner's hand check of 20.** Corrections to the style go back into the notes. A paraphrase the owner rejects is withdrawn and rewritten.
- [ ] **Step 4: Batches 2 to 5** (about 50 each, until the database holds 200 or more imported cases and the manifests hold about 230 entries so skips do not leave the target short). After each batch: check, dry run, apply, counts.
- [ ] **Step 5:** Report: the number imported, the gate's skips by rule, per-repository counts, and the proof lines for the ticket (all imported cases have a link, a licence and a verdict citing the fix; none authored by an organic-looking agent).

---

### Task 8: Notes and the terms list (AC-901 to AC-906)

**Files:** Create `docs/import-sources.md`; Modify `README.md`, `docs/ticket.md`, `docs/directory.md`, `docs/threats.md`, `docs/runbook.md`. The builder writes these directly and says so.

- [ ] **Step 1:** `docs/import-sources.md`: the eleven repositories with their licence, why each is allowed, the three that are excluded and why, the rules for an entry (paraphrase, links, no copying), the selection rules, the takedown route (an administrator withdraws the case, and the case's source link says whom to contact), and the statement that the court does not claim the original text.
- [ ] **Step 2:** README "Seed cases" section (what imported means, how to run the import, dry-run first, where the manifests are); tickets AC-901 to AC-906 with the counts; directory entries for `lib/import/`, the scripts, the data folder and the components; threats T1 and T11 notes; the runbook's import and takedown steps.
- [ ] **Step 3: Commit** `docs: N9 seed cases notes and the import sources list`.

---

## Self-review

- **Spec coverage:** AC-901 Tasks 1 and 5; AC-902 Tasks 1 and 8; AC-903 Tasks 2 and 4; AC-904 Task 3; AC-905 Task 3; AC-906 Tasks 6 and 7. The plan's "Done when" maps to: 200 or more cases each with a link and a verdict citing the fix (Task 7 counts, Task 3 shape), zero cases by bots posing as organic (the importer is the only author of imports, and is labelled; Task 4 rule and test), the UI shows an imported badge (Task 5).
- **Placeholders:** none. `data/imports/` and `.import-work/` are created by Tasks 7 and 4.
- **Consistency:** names match across tasks (`IMPORT`, `IMPORT_SOURCES`, `licenseOf`, `parseGithubUrl`, `ensureImporter`, `parseManifestEntry`, `guardParaphrase`, `importCase`, `runImport`, `ImportedNotice`).
- **Risk to watch:** the builder's own reading of fetched text. It is data, and the paraphrase is the only thing that crosses into the repository.
