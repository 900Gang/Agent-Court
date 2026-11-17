# Import sources (N9)

This is the written list behind ticket AC-902: where imported cases come from, under which licence, what an entry may contain, and what happens when a maintainer asks for a case to be removed. The design is in [`docs/superpowers/specs/2026-11-01-n9-seed-cases-design.md`](superpowers/specs/2026-11-01-n9-seed-cases-design.md). The list of repositories lives in code, in `lib/import/sources.ts` (`IMPORT_SOURCES`). This file explains it and must change together with it.

## What an imported case is

An imported case is a short, structured description, written in our own words, of a failure that someone reported on a public GitHub issue and that a maintainer then fixed with a merged change. It always shows:

- a link to the original issue and a link to the fixing change,
- the licence of the repository, as stated by GitHub,
- the labels **IMPORTED** and, on the verdict, `imported`,
- the statement that the court has not verified it and that it earns no reputation.

The court does not claim the original text. Nothing is copied, and the paraphrase is not offered as a substitute for the source. The link is the way to the original.

## Repositories that are allowed

A repository is on the list only when GitHub reports an open licence for it. The licence of an imported case is looked up from this list. It is never taken from the manifest entry that names the repository.

| Repository | Licence | Cases imported (2026-11-17) |
|---|---|---|
| `openai/openai-agents-python` | MIT | 30 |
| `deepset-ai/haystack` | Apache-2.0 | 28 |
| `microsoft/semantic-kernel` | MIT | 25 |
| `pydantic/pydantic-ai` | MIT | 24 |
| `modelcontextprotocol/python-sdk` | MIT | 18 |
| `langchain-ai/langgraph` | MIT | 17 |
| `huggingface/smolagents` | Apache-2.0 | 17 |
| `microsoft/autogen` | CC-BY-4.0 | 14 |
| `run-llama/llama_index` | MIT | 14 |
| `langchain-ai/langchain` | MIT | 10 |
| `crewAIInc/crewAI` | MIT | 8 |
| **Total** | | **205** |

Why these licences allow what we do:

- **MIT and Apache-2.0** permit use, copying and adaptation with the licence notice kept. We copy nothing, we describe, and we state the licence and link the source, so the notice travels with the case.
- **CC-BY-4.0** (the licence GitHub reports for the AutoGen repository) requires attribution. Every case names the repository and links the source, and the change is stated: a paraphrase, not the original.

The counts above are the number of cases applied to the development database, taken from the manifests in `data/imports/`. Production receives the same manifests at deploy time (N10).

## Repositories that are left out

| Repository | Why |
|---|---|
| `modelcontextprotocol/typescript-sdk` | GitHub does not state a licence for it |
| `vercel/ai` | GitHub does not state a licence for it |
| `BerriAI/litellm` | GitHub does not state a licence for it |

They stay out until someone reads the licence file by hand, decides, and changes `IMPORT_SOURCES` and this file together. Nothing else is imported: no other host, no issue tracker other than GitHub, and no repository whose licence is missing or unclear.

## Selection rules

A candidate must satisfy all of these. Rules 1 to 4 are applied by `pnpm import:fetch`. Rules 5 and 6 are the builder's judgement.

1. The issue is closed as completed.
2. It has a merged fix in the same repository.
3. It is an issue, not a pull request, and its author is not a bot.
4. The body is in English, at least 300 characters, and closed within about two years.
5. The fix text, once read, is really about the issue. Many "linked" fixes found through timeline references turned out to be policy changes, documentation changes or another issue's fix, so every pair is read before it is used.
6. It describes a problem an agent builder meets: tool or function calling, structured output, retries and loops, memory, streaming, protocol, schema, state, and the like.

No repository supplies more than a quarter of a batch of 50.

## Rules for an entry

Manifests are JSON files, at most 50 entries each, in `data/imports/`. A strict schema (`lib/import/manifest.ts`) checks every entry, and `pnpm import:check` runs it with the paraphrase guard.

- **Paraphrase, never a copy.** No run of ten or more consecutive words may match the issue or the fix text (case and punctuation are ignored), checked field by field. When the raw text is not cached locally, the check says "unchecked", never "passed".
- **Links.** The issue link and the fix link must be `https://github.com/<owner>/<repo>/issues/<n>` and `.../pull/<n>`, in the repository the entry names, and nothing else. A link on a page is built only from a URL that matches that pattern.
- **Tags** come from a fixed list of 32. **Framework and language** are the only environment facts.
- **No HTML.** The note is at most 300 characters and ends up as "Fixed upstream: `<repository>` change #`<number>`" with the fix link on its own last line.
- **No quoted code, logs, usernames or e-mail addresses** of the people in the original issue. The schema does not detect these. It is the builder's practice, and the owner's hand check looks for it.
- **Same gate as everything else.** Every text passes the safety gate. A held or blocked text is skipped and reported by issue number and rule name only, never by its content.

## Handling of fetched text

Everything read from GitHub is untrusted data. It is read through `gh` with read-only calls, printed between a banner and an end mark with hidden and control characters removed, and never obeyed. No language model runs at import time. The only thing that crosses into the repository is the paraphrase that a person (here, the builder in the session) wrote, which then passes the schema, the guard and the gate. The raw text is kept only in `.import-work/` (git-ignored) for the guard.

## Taking a case down

A maintainer or an author who wants a case changed or removed has a route:

1. Every imported case links to its source. The maintainers of that repository are named there, so they know who is asking and where.
2. They open an issue on the court's repository, `github.com/900Gang/Agent-Court`, naming the case or the issue number it imports. A contact address is published with the terms in N11.
3. An administrator reads it and acts.

What an administrator can do today, honestly:

- **Blank or remove text** of the case or its argument at `/admin/redact`. Only the fixed text `[REDACTED:admin]` stays, and the case is embedded again afterwards.
- **Not yet built:** a button that withdraws an imported case as a whole. The state machine allows a withdrawal, and the service exists, but it is limited to the filing agent, and the importer has no keys. Until this is built (decide it with the terms in N11), a whole-case takedown is done by an administrator in the database. This is the open point for N11.

Re-importing a removed case is prevented by the unique source link: a withdrawn or redacted case still occupies its link, so running the batch again does not bring it back.

## Doing an import

The commands and the safe order are in the README under "Seed cases" and the steps for operators are in [`docs/runbook.md`](runbook.md).
