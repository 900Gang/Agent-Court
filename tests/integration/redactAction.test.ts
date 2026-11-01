import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argumentsTable, operators, type Operator } from "@/db/schema";
import { redactCore } from "@/lib/admin/redactCore";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { parseSearchQuery } from "@/lib/schemas/search";
import { embedCase } from "@/lib/services/embeddingService";
import { REDACTION_PLACEHOLDER } from "@/lib/services/redactionService";
import { searchKeyword } from "@/lib/services/searchService";
import { createRecordingProvider, throwingProvider } from "../helpers/embeddings";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";
const P = REDACTION_PLACEHOLDER;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeOperator(role: "operator" | "admin" = "admin", status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Operator", role, status }).returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

type Input = { targetType: string; targetId: string; field: string; fragment: string; blank: string };
const run = (operator: Operator | null, input: Partial<Input>, over: Partial<ActionDeps> = {}) =>
  redactCore(deps(operator, over), { targetType: "case", targetId: UNKNOWN, field: "title", fragment: "", blank: "", ...input });

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

async function publicCase(word = "zzquuxword") {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `Retry loop ${word} never stops`, summary: "The agent retries forever.", expected: "It stops.", actual: "It never stops." });
  const author = await f.makeAgent();
  const [argument] = await t.db.insert(argumentsTable).values({ caseId: c.id, agentId: author.actor.agentId, status: "active", reasoning: `Reasoning with ${word}`, proposedChange: "Set max retries." }).returning();
  return { c, argument, word };
}

const title = async (id: string) => (await t.sql(`select title from cases where id = $1`, [id]))[0].title as string;
const hashOf = async (id: string) => (await t.sql(`select text_hash from case_embeddings where case_id = $1`, [id]))[0]?.text_hash as string | undefined;

async function keywordFinds(word: string, caseId: string) {
  const query = parseSearchQuery(new URLSearchParams({ q: word }));
  if (!query.ok) throw new Error("query refused");
  return (await searchKeyword(t.db, query.value)).some((item) => item.case.id === caseId);
}

describe("redactCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin", async (_label, over) => {
    const admin = await makeOperator();
    const s = await publicCase();
    const input = { targetId: s.c.id, fragment: s.word };
    expect(codeOf(await run(admin, input, over))).toBe("origin_mismatch");
    expect(codeOf(await run(null, input, over))).toBe("origin_mismatch");
    expect(await title(s.c.id)).toContain(s.word);
  });

  it("answers anyone who is not an active admin exactly as it answers a missing sign-in, and changes nothing", async () => {
    const deleted = { ...(await makeOperator()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    const who: Array<[string, Operator | null]> = [
      ["nobody", null],
      ["an ordinary operator", await makeOperator("operator")],
      ["a pending admin", await makeOperator("admin", "pending")],
      ["a suspended admin", await makeOperator("admin", "suspended")],
      ["a deleted admin", deleted],
    ];
    const s = await publicCase();
    const answers = new Set<string>();
    for (const [label, operator] of who) {
      const result = await run(operator, { targetId: s.c.id, fragment: s.word });
      expect(codeOf(result), label).toBe("not_signed_in");
      answers.add(JSON.stringify(result));
    }
    expect(answers.size).toBe(1);
    expect(await title(s.c.id)).toContain(s.word);
  });
});

describe("redactCore: the form", () => {
  it("removes a fragment, and answers with the count only", async () => {
    const admin = await makeOperator();
    const s = await publicCase();
    const result = await run(admin, { targetId: s.c.id, fragment: s.word });
    expect(result).toEqual({ ok: true, value: { removed: s.word.length } });
    expect(await title(s.c.id)).toBe(`Retry loop ${P} never stops`);
  });

  it("blanks the whole field when the box is ticked and the fragment is empty", async () => {
    const admin = await makeOperator();
    const s = await publicCase();
    expect((await run(admin, { targetId: s.c.id, blank: "on" })).ok).toBe(true);
    expect(await title(s.c.id)).toBe(P);
  });

  it("refuses an empty fragment with the box unticked, and a fragment together with the box, writing nothing", async () => {
    const admin = await makeOperator();
    const s = await publicCase();
    expect(codeOf(await run(admin, { targetId: s.c.id, fragment: "", blank: "" }))).toBe("invalid");
    expect(codeOf(await run(admin, { targetId: s.c.id, fragment: s.word, blank: "on" }))).toBe("invalid");
    expect(await title(s.c.id)).toBe(`Retry loop ${s.word} never stops`);
  });

  it("answers redact_target_not_found, nothing_to_redact and invalid with fixed codes", async () => {
    const admin = await makeOperator();
    const s = await publicCase();
    expect(codeOf(await run(admin, { targetId: UNKNOWN, fragment: "x" }))).toBe("redact_target_not_found");
    expect(codeOf(await run(admin, { targetId: s.c.id, fragment: "not in the title" }))).toBe("nothing_to_redact");
    expect(codeOf(await run(admin, { targetId: "nope", fragment: "x" }))).toBe("invalid");
    expect(codeOf(await run(admin, { targetType: "argument", field: "title", targetId: s.argument.id, fragment: "x" }))).toBe("invalid");
  });

  it("never puts what was submitted into the answer", async () => {
    const result = await run(await makeOperator(), { targetType: "<script>alert(1)</script>", targetId: "<img src=x onerror=alert(1)>", field: "<b>x</b>", fragment: "<i>y</i>" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const bad of ["<script>", "<img", "<b>", "<i>"]) expect(text).not.toContain(bad);
  });
});

describe("redactCore: the vector", () => {
  it("embeds the changed text, replaces the vector, and never sends the removed word to the provider", async () => {
    const admin = await makeOperator();
    const s = await publicCase();
    const provider = createRecordingProvider();
    await embedCase(t.db, provider, s.c.id);
    const hashBefore = await hashOf(s.c.id);
    expect(provider.received().some((text) => text.includes(s.word))).toBe(true);
    expect(await keywordFinds(s.word, s.c.id)).toBe(true);

    expect((await run(admin, { targetId: s.c.id, fragment: s.word }, { embedder: provider })).ok).toBe(true);

    const last = provider.received().at(-1) ?? "";
    expect(last).toContain(P);
    expect(last).not.toContain(s.word);
    expect(await hashOf(s.c.id)).not.toBe(hashBefore);
    expect(await keywordFinds(s.word, s.c.id)).toBe(false);
  });

  it("leaves the vector alone for an argument, which the embedding never saw", async () => {
    const admin = await makeOperator();
    const s = await publicCase("yyplinkword");
    const provider = createRecordingProvider();
    await embedCase(t.db, provider, s.c.id);
    const callsBefore = provider.calls.length;
    const hashBefore = await hashOf(s.c.id);
    expect((await run(admin, { targetType: "argument", targetId: s.argument.id, field: "reasoning", fragment: s.word }, { embedder: provider })).ok).toBe(true);
    expect(provider.calls.length).toBe(callsBefore);
    expect(await hashOf(s.c.id)).toBe(hashBefore);
  });

  it("still applies the redaction when the provider fails, and when there is no provider", async () => {
    const admin = await makeOperator();
    const failing = await publicCase("failword");
    expect((await run(admin, { targetId: failing.c.id, fragment: failing.word }, { embedder: throwingProvider })).ok).toBe(true);
    expect(await title(failing.c.id)).toBe(`Retry loop ${P} never stops`);
    const none = await publicCase("noneword");
    expect((await run(admin, { targetId: none.c.id, fragment: none.word })).ok).toBe(true);
    expect(await title(none.c.id)).toBe(`Retry loop ${P} never stops`);
  });

  it("does not call the provider for a held case", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const held = await f.insertCase(filer.actor.agentId, { status: "held", title: "Held heldword title" });
    const provider = createRecordingProvider();
    expect((await run(admin, { targetId: held.id, fragment: "heldword" }, { embedder: provider })).ok).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("the messages for the new codes", () => {
  it.each(["redact_target_not_found", "nothing_to_redact"])("%s has its own fixed message and hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });
});
