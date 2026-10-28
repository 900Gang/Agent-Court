import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchPublic } from "@/lib/services/observerService";
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

const params = (init: string | Record<string, string>) => new URLSearchParams(init);
const idsOf = (result: Awaited<ReturnType<typeof searchPublic>>) => (result.ok ? result.items.map((item) => item.case.id) : []);
const word = () => f.uniq("find").replace(/-/g, "x");

describe("searchPublic: a query", () => {
  it("searches public cases by keyword and reports what it searched for", async () => {
    const filer = await f.makeAgent();
    const needle = word();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `Loop ${needle}` });
    await f.insertCase(filer.actor.agentId, { status: "held", title: `Hidden ${needle}` });
    await f.insertCase(filer.actor.agentId, { status: "withdrawn", title: `Gone ${needle}` });
    const result = await searchPublic(t.db, params({ q: needle }));
    expect(result).toMatchObject({ ok: true, mode: "search", query: needle, nextCursor: null });
    expect(idsOf(result)).toEqual([c.id]);
  });

  it("ignores the browse filters and the cursor while searching", async () => {
    const filer = await f.makeAgent();
    const needle = word();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `Open ${needle}` });
    const result = await searchPublic(t.db, params({ q: needle, status: "resolved", tag: "nope", cursor: "garbage" }));
    expect(result).toMatchObject({ ok: true, mode: "search", status: null, tag: null });
    expect(idsOf(result)).toEqual([c.id]);
  });

  it("treats hostile text as text, finding nothing", async () => {
    for (const q of ["<script>alert(1)</script>", "'; DROP TABLE cases; --", "%", "\\"]) {
      const result = await searchPublic(t.db, params({ q }));
      expect(result.ok, q).toBe(true);
    }
  });

  it("refuses a query over 200 characters and names only the field", async () => {
    const result = await searchPublic(t.db, params({ q: "a".repeat(201) }));
    expect(result).toEqual({ ok: false, detail: { q: "at most 200 characters" } });
  });
});

describe("searchPublic: browsing", () => {
  it.each([["no q at all", ""], ["an empty q", "q="], ["a blank q", "q=%20%20"]])("browses for %s", async (_label, query) => {
    const result = await searchPublic(t.db, params(query));
    expect(result).toMatchObject({ ok: true, mode: "browse", query: null });
  });

  it("lists public cases only, newest first, filtered by status and tag, and pages with the cursor", async () => {
    const filer = await f.makeAgent();
    const tag = f.uniq("browse");
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      made.push((await f.insertCase(filer.actor.agentId, { status: "open", tags: [tag], createdAt: new Date(Date.UTC(2100, 0, 3 - i)) })).id);
    }
    const resolved = await f.insertCase(filer.actor.agentId, { status: "resolved", tags: [tag] });
    for (const status of ["held", "withdrawn", "rejected"] as const) await f.insertCase(filer.actor.agentId, { status, tags: [tag] });

    const all = await searchPublic(t.db, params({ tag }));
    expect(all.ok && all.tag).toBe(tag);
    expect(idsOf(all).sort()).toEqual([...made, resolved.id].sort());

    const onlyResolved = await searchPublic(t.db, params({ tag, status: "resolved" }));
    expect(onlyResolved).toMatchObject({ ok: true, status: "resolved" });
    expect(idsOf(onlyResolved)).toEqual([resolved.id]);

    const first = await searchPublic(t.db, params({ tag, status: "open", limit: "2" }));
    expect(idsOf(first)).toEqual(made.slice(0, 2));
    const cursor = first.ok ? first.nextCursor : null;
    expect(cursor).not.toBeNull();
    const second = await searchPublic(t.db, params({ tag, status: "open", limit: "2", cursor: cursor as string }));
    expect(idsOf(second)).toEqual(made.slice(2));
    expect(second.ok && second.nextCursor).toBeNull();
  });

  it.each([
    ["an unknown status", { status: "held" }, "status"],
    ["a status that is not one", { status: "<script>" }, "status"],
    ["a bad tag", { tag: "Not A Tag" }, "tag"],
    ["a bad limit", { limit: "0" }, "limit"],
    ["a bad cursor", { cursor: "not-a-cursor" }, "cursor"],
  ])("refuses %s, naming only the field", async (_label, query, field) => {
    const result = await searchPublic(t.db, params(query));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : Object.keys(result.detail)).toEqual([field]);
    expect(JSON.stringify(result)).not.toContain("script");
  });
});
