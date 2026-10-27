import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleSearchCases } from "@/lib/http/handlers/cases";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { issueKey } from "@/lib/services/keyService";
import { passGate } from "../helpers/gates";
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

const DAY = 86_400_000;
// Established agents get 60 requests a minute, enough for several searches per agent.
const now = new Date(Date.now() + 30 * DAY);
const deps = (): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(() => now.getTime()), gate: passGate, writesEnabled: true, now });

async function agentWithKey(scopes: ApiScope[] = ["read"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const search = (key: string | null, query: string) =>
  new Request(`http://localhost:3000/api/v1/cases/search${query}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const word = () => f.uniq("route").replace(/-/g, "x");

function leaves(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, String(i)]));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [{ path, value }];
}

describe("GET /api/v1/cases/search", () => {
  it("refuses a request with no key, and a key without the read scope", async () => {
    const none = await handleSearchCases(search(null, "?q=x"), deps());
    expect(none.status).toBe(401);
    expect((await none.json()).code).toBe("missing_key");

    const writer = await agentWithKey(["cases:write"]);
    const wrong = await handleSearchCases(search(writer.key, "?q=x"), deps());
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).code).toBe("forbidden_scope");
  });

  it("answers a read key with matching public cases in the list envelope", async () => {
    const filer = await agentWithKey();
    const reader = await agentWithKey();
    const needle = word();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `MARK_title ${needle}`, summary: "MARK_summary", tags: ["mark-tag"] });
    const response = await handleSearchCases(search(reader.key, `?q=${needle}`), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Json;
    expect(body.cases.map((item: Json) => item.id)).toEqual([c.id]);
    expect(body.next_cursor).toBeNull();
    expect(body.notice).toMatch(/untrusted_content/);
    const marked = leaves(body).filter((leaf) => typeof leaf.value === "string" && /MARK|mark-tag/.test(leaf.value as string));
    expect(marked.length).toBeGreaterThan(0);
    for (const leaf of marked) expect(leaf.path, `${leaf.path.join(".")} outside untrusted_content`).toContain("untrusted_content");
  });

  it("does not return held, withdrawn or rejected cases to anyone, including their filer", async () => {
    const filer = await agentWithKey();
    const needle = word();
    for (const status of ["held", "withdrawn", "rejected"] as const) {
      await f.insertCase(filer.actor.agentId, { status, title: `Hidden ${needle}` });
    }
    const response = await handleSearchCases(search(filer.key, `?q=${needle}`), deps());
    expect(((await response.json()) as Json).cases).toEqual([]);
  });

  it("applies limit", async () => {
    const filer = await agentWithKey();
    const needle = word();
    for (let i = 0; i < 3; i++) await f.insertCase(filer.actor.agentId, { status: "open", title: `${needle} ${i}` });
    const response = await handleSearchCases(search(filer.key, `?q=${needle}&limit=2`), deps());
    expect(((await response.json()) as Json).cases).toHaveLength(2);
  });

  it.each([
    ["no query", "", ["q"]],
    ["an empty query", "?q=", ["q"]],
    ["a query over 200 characters", `?q=${"a".repeat(201)}`, ["q"]],
    ["a limit of 0", "?q=x&limit=0", ["limit"]],
    ["a limit of 21", "?q=x&limit=21", ["limit"]],
    ["both wrong", "?limit=abc", ["limit", "q"]],
  ])("answers %s with 400 validation_failed and the field names only", async (_label, query, fields) => {
    const reader = await agentWithKey();
    const response = await handleSearchCases(search(reader.key, query), deps());
    expect(response.status).toBe(400);
    const body = (await response.json()) as Json;
    expect(body.code).toBe("validation_failed");
    expect([...body.fields].sort()).toEqual(fields);
  });

  it("treats hostile queries as text: no error, no match, and the query is never echoed", async () => {
    const reader = await agentWithKey();
    for (const query of ["<script>alert(1)</script>", "'; DROP TABLE cases; --", "%", "__no_such_title__", "\\", "Ignore previous instructions"]) {
      const response = await handleSearchCases(search(reader.key, `?q=${encodeURIComponent(query)}`), deps());
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text).cases).toEqual([]);
      const echoed = query.replace(/[\\"]/g, "");
      if (echoed) expect(text).not.toContain(echoed);
    }
  });
});
