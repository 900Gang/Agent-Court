import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cases } from "@/db/schema";
import { eq } from "drizzle-orm";
import { errorResponse } from "@/lib/http/errors";
import { handleCronRescan } from "@/lib/http/handlers/cron";
import { createGate } from "@/lib/safety/engine";
import { failClosedGate } from "@/lib/safety/stub";
import { fileCase } from "@/lib/services/caseService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-25T12:00:00.000Z");
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cases, moderation_events cascade");
  await t.sql("set role app_server");
});

const deps = (secret: string | null = SECRET) => ({ db: t.db, gate: createGate(), secret });
const call = (init: RequestInit & { url?: string } = {}, secret: string | null = SECRET) =>
  handleCronRescan(new Request(init.url ?? "http://localhost:3000/api/cron/rescan", init), deps(secret));

async function heldCaseWithSecret() {
  const { actor } = await f.makeAgent();
  const filed = f.unwrap(
    await fileCase(
      t.db,
      failClosedGate,
      actor,
      {
        title: "Tool call loops",
        summary: `Summary: the shell history held ${awsKey} and nothing else worth reading in it.`,
        expected: "One call.",
        actual: "Ten calls.",
        evidence: [],
      },
      NOW,
    ),
  );
  return filed.case;
}

const summaryOf = async (id: string) => (await t.db.select().from(cases).where(eq(cases.id, id)))[0].summary;

describe("cron rescan endpoint: who may call it", () => {
  const refused: Array<[string, RequestInit, string | null]> = [
    ["no header", {}, SECRET],
    ["a wrong secret", { headers: { authorization: "Bearer not-the-secret" } }, SECRET],
    ["the Basic scheme", { headers: { authorization: `Basic ${SECRET}` } }, SECRET],
    ["a secret in the query string", { url: `http://localhost:3000/api/cron/rescan?secret=${SECRET}` } as RequestInit, SECRET],
    ["the right header when no secret is configured", { headers: { authorization: `Bearer ${SECRET}` } }, null],
  ];

  it.each(refused)("answers %s with the same fixed 401", async (_label, init, secret) => {
    const response = await call(init, secret);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await errorResponse("unauthorized").text());
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not touch any content when it refuses", async () => {
    const c = await heldCaseWithSecret();
    await call({}, SECRET);
    await call({ headers: { authorization: "Bearer wrong" } }, SECRET);
    expect(await summaryOf(c.id)).toContain(awsKey);
  });
});

describe("cron rescan endpoint: an authorized call", () => {
  const authorized = { headers: { authorization: `Bearer ${SECRET}` } };

  it("re-screens held content and answers with the counts", async () => {
    const c = await heldCaseWithSecret();
    const response = await call(authorized);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["examined", "failed", "publishedStale", "redacted", "rejected", "unchanged"]);
    expect(body).toMatchObject({ examined: 1, redacted: 1, rejected: 0, unchanged: 0, failed: 0 });
    expect(await summaryOf(c.id)).toContain("[REDACTED:aws_access_key]");
    expect(await summaryOf(c.id)).not.toContain(awsKey);
  });

  it("answers a second call with nothing left to do", async () => {
    await heldCaseWithSecret();
    await call(authorized);
    expect(await (await call(authorized)).json()).toMatchObject({ examined: 0 });
  });

  it("works for POST as well as GET, and ignores query strings", async () => {
    await heldCaseWithSecret();
    const response = await call({ ...authorized, method: "POST", url: "http://localhost:3000/api/cron/rescan?limit=1&apply=false&x=%00" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ examined: 1, redacted: 1 });
  });

  it("never puts the secret, or any stored text, in the response", async () => {
    await heldCaseWithSecret();
    const text = await (await call(authorized)).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(awsKey);
    expect(text).not.toContain("shell history");
  });
});

describe("cron rescan route file", () => {
  it("exports GET and POST, and is never cached", async () => {
    const route = await import("@/app/api/cron/rescan/route");
    expect(typeof route.GET).toBe("function");
    expect(typeof route.POST).toBe("function");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
