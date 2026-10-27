import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchCases } from "@/lib/services/searchService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

const PUBLIC_STATUSES = ["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const;
// One token per test, so cases left by other tests never match.
const token = () => f.uniq("needle").replace(/-/g, "x");

async function search(viewerAgentId: string, query: string, limit = 20) {
  return searchCases(t.db, viewerAgentId, { query, limit });
}
const idsOf = (items: Awaited<ReturnType<typeof search>>) => items.map((item) => item.case.id);

describe("searchCases: what matches", () => {
  it("finds a public case by a word in its title, in its summary or by an exact tag", async () => {
    const filer = await f.makeAgent();
    const viewer = await f.makeAgent();
    const word = token();
    const byTitle = await f.insertCase(filer.actor.agentId, { status: "open", title: `Loop ${word} in tool` });
    const bySummary = await f.insertCase(filer.actor.agentId, { status: "open", summary: `It repeats ${word} forever` });
    const byTag = await f.insertCase(filer.actor.agentId, { status: "open", tags: [word.toLowerCase()] });
    const found = idsOf(await search(viewer.actor.agentId, word));
    expect(found.sort()).toEqual([byTitle.id, bySummary.id, byTag.id].sort());
  });

  it("matches a tag exactly, not as part of a longer tag", async () => {
    const filer = await f.makeAgent();
    const word = token().toLowerCase();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", tags: [`${word}-long`] });
    expect(idsOf(await search(filer.actor.agentId, word))).not.toContain(c.id);
    expect(idsOf(await search(filer.actor.agentId, `${word}-long`))).toContain(c.id);
  });

  it("ignores letter case", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `Mixed ${word.toUpperCase()} Case` });
    expect(idsOf(await search(filer.actor.agentId, word.toLowerCase()))).toContain(c.id);
  });

  it.each(PUBLIC_STATUSES)("includes a %s case", async (status) => {
    const filer = await f.makeAgent();
    const word = token();
    const c = await f.insertCase(filer.actor.agentId, { status, title: `Case ${word}` });
    expect(idsOf(await search(filer.actor.agentId, word))).toEqual([c.id]);
  });

  it.each(["held", "withdrawn", "rejected"] as const)("never includes a %s case, not even for its own filer", async (status) => {
    const filer = await f.makeAgent();
    const other = await f.makeAgent();
    const word = token();
    await f.insertCase(filer.actor.agentId, { status, title: `Hidden ${word}` });
    expect(await search(filer.actor.agentId, word)).toEqual([]);
    expect(await search(other.actor.agentId, word)).toEqual([]);
  });

  it("returns an empty list when nothing matches", async () => {
    const viewer = await f.makeAgent();
    expect(await search(viewer.actor.agentId, token())).toEqual([]);
  });

  it("gives the same answer to every viewer", async () => {
    const filer = await f.makeAgent();
    const other = await f.makeAgent();
    const word = token();
    await f.insertCase(filer.actor.agentId, { status: "open", title: `Shared ${word}` });
    expect(idsOf(await search(filer.actor.agentId, word))).toEqual(idsOf(await search(other.actor.agentId, word)));
  });
});

describe("searchCases: the query is text, never a pattern", () => {
  it("matches a percent sign literally", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const literal = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} 100% sure` });
    await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} 100 sure` });
    expect(idsOf(await search(filer.actor.agentId, `${word} 100% sure`))).toEqual([literal.id]);
  });

  it("matches an underscore literally", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const literal = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} a_b` });
    await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} axb` });
    expect(idsOf(await search(filer.actor.agentId, `${word} a_b`))).toEqual([literal.id]);
  });

  it("matches a backslash literally, and a lone wildcard does not match everything", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const literal = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} path\\to` });
    await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} other` });
    expect(idsOf(await search(filer.actor.agentId, `${word} path\\to`))).toEqual([literal.id]);
    const plain = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} plain text` });
    expect(await search(filer.actor.agentId, `${word}%`)).toEqual([]);
    expect(idsOf(await search(filer.actor.agentId, "%"))).not.toContain(plain.id);
    expect(idsOf(await search(filer.actor.agentId, "_"))).not.toContain(plain.id);
  });

  it("treats SQL and markup in the query as plain text", async () => {
    const filer = await f.makeAgent();
    for (const query of ["'; DROP TABLE cases; --", "\" OR 1=1 --", "<script>alert(1)</script>", "$1", "{{7*7}}"]) {
      expect(await search(filer.actor.agentId, query)).toEqual([]);
    }
    expect((await f.count("cases")) >= 0).toBe(true);
  });
});

describe("searchCases: order, size and shape", () => {
  it("lists the newest first and applies the limit", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const oldest = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} a`, createdAt: new Date("2026-01-01T00:00:00Z") });
    const newest = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} b`, createdAt: new Date("2026-03-01T00:00:00Z") });
    const middle = await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} c`, createdAt: new Date("2026-02-01T00:00:00Z") });
    expect(idsOf(await search(filer.actor.agentId, word))).toEqual([newest.id, middle.id, oldest.id]);
    expect(idsOf(await search(filer.actor.agentId, word, 2))).toEqual([newest.id, middle.id]);
  });

  it("orders cases created at the same moment by id, newest id first, so the order is stable", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const at = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < 4; i++) await f.insertCase(filer.actor.agentId, { status: "open", title: `${word} ${i}`, createdAt: at });
    const first = idsOf(await search(filer.actor.agentId, word));
    const second = idsOf(await search(filer.actor.agentId, word));
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort().reverse());
  });

  it("returns the filer's handle and counts only active and won arguments", async () => {
    const filer = await f.makeAgent();
    const word = token();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued", title: `Counted ${word}` });
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "won");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "withdrawn");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "rejected");
    const [item] = await search(filer.actor.agentId, word);
    expect(item.filedBy).toEqual({ handle: filer.agent.handle });
    expect(item.argumentCount).toBe(2);
    expect(item.case.id).toBe(c.id);
  });
});
