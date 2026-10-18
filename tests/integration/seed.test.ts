import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "@/db/seed";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

async function count(from: string): Promise<number> {
  const [row] = await t.sql(`select count(*)::int as n from ${from}`);
  return row.n as number;
}

const seededOperators = `operators where github_id like 'seed:%'`;
const seededAgents = `agents where handle like 'seed-%'`;

describe("seed refusals", () => {
  it.each(["production", "staging", "prod"])("refuses to run when APP_ENV is %s", async (appEnv) => {
    await expect(seed(t.db, { appEnv })).rejects.toThrow(
      "seed refused: APP_ENV must be development or test",
    );
  });

  it("writes nothing when it refuses", async () => {
    expect(await count(seededOperators)).toBe(0);
    expect(await count(seededAgents)).toBe(0);
    expect(await count("cases")).toBe(0);
  });
});

describe("seed data", () => {
  it("creates three operators, two agents and three cases, and reports the counts", async () => {
    const result = await seed(t.db, { appEnv: "test" });
    expect(result).toEqual({ operators: 3, agents: 2, cases: 3 });
    expect(await count(seededOperators)).toBe(3);
    expect(await count(seededAgents)).toBe(2);
    expect(await count("cases")).toBe(3);
  });

  it("creates one admin and two ordinary operators, all active and not linked to a login", async () => {
    const rows = await t.sql(
      `select role, status, auth_user_id, verified_at from operators where github_id like 'seed:%'`,
    );
    expect(rows.filter((row) => row.role === "admin")).toHaveLength(1);
    expect(rows.filter((row) => row.role === "operator")).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.auth_user_id).toBeNull();
      expect(row.verified_at).not.toBeNull();
    }
  });

  it("uses identities that can never match a real GitHub account or mailbox", async () => {
    const rows = await t.sql(`select github_id, email from operators where github_id like 'seed:%'`);
    for (const row of rows) {
      expect(String(row.github_id)).toMatch(/^seed:[a-z0-9-]+$/);
      expect(String(row.email)).toMatch(/@example\.test$/);
    }
  });

  it("puts the agents under the two ordinary operators", async () => {
    const rows = await t.sql(
      `select o.role from agents a join operators o on o.id = a.operator_id where a.handle like 'seed-%'`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.role).toBe("operator");
  });

  it("creates open, published cases owned by the seed agents, with valid tags", async () => {
    const rows = await t.sql(
      `select c.status, c.published_at, c.tags, c.source from cases c
       join agents a on a.id = c.agent_id where a.handle like 'seed-%'`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("open");
      expect(row.published_at).not.toBeNull();
      expect(row.source).toBe("native");
      expect((row.tags as string[]).length).toBeGreaterThan(0);
    }
  });

  it("creates no API keys", async () => {
    expect(await count("api_keys")).toBe(0);
  });

  it("can run again without duplicating anything", async () => {
    const again = await seed(t.db, { appEnv: "development" });
    expect(again).toEqual({ operators: 3, agents: 2, cases: 3 });
    expect(await count(seededOperators)).toBe(3);
    expect(await count(seededAgents)).toBe(2);
    expect(await count("cases")).toBe(3);
  });
});

describe("seed privileges", () => {
  it("works with only the app role's privileges on an empty database", async () => {
    const fresh = await createTestDb();
    try {
      await fresh.sql("set role app_server");
      const result = await seed(fresh.db, { appEnv: "development" });
      await fresh.sql("reset role");
      expect(result).toEqual({ operators: 3, agents: 2, cases: 3 });
    } finally {
      await fresh.close();
    }
  });
});