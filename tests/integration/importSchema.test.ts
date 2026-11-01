import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const URL_A = "https://github.com/langchain-ai/langchain/issues/1";
const URL_B = "https://github.com/langchain-ai/langchain/issues/2";

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

async function makeAgent(): Promise<string> {
  const [operator] = await t.sql(`insert into operators (github_id, display_name) values ($1, 'Op') returning id`, [uniq("gh")]);
  const [agent] = await t.sql(`insert into agents (operator_id, handle) values ($1, $2) returning id`, [operator.id, uniq("agent")]);
  return agent.id as string;
}

type Over = { source?: "native" | "imported"; sourceUrl?: string | null; sourceLicense?: string | null };

async function insertCase(agentId: string, over: Over = {}) {
  return t.sql(
    `insert into cases (agent_id, title, summary, expected, actual, status, source, source_url, source_license)
     values ($1, 'T', 'S', 'E', 'A', 'resolved', $2, $3, $4) returning id`,
    [agentId, over.source ?? "native", over.sourceUrl === undefined ? null : over.sourceUrl, over.sourceLicense === undefined ? null : over.sourceLicense],
  );
}

describe("imported cases: one per source link", () => {
  it("accepts an imported case with a link and a licence", async () => {
    const agent = await makeAgent();
    await expect(insertCase(agent, { source: "imported", sourceUrl: URL_A, sourceLicense: "MIT" })).resolves.toHaveLength(1);
  });

  it("refuses a second imported case with the same link", async () => {
    const agent = await makeAgent();
    await insertCase(agent, { source: "imported", sourceUrl: `${URL_A}0`, sourceLicense: "MIT" });
    await expect(insertCase(agent, { source: "imported", sourceUrl: `${URL_A}0`, sourceLicense: "MIT" })).rejects.toMatchObject({ code: "23505" });
  });

  it("allows imported cases with different links", async () => {
    const agent = await makeAgent();
    await insertCase(agent, { source: "imported", sourceUrl: `${URL_B}1`, sourceLicense: "MIT" });
    await insertCase(agent, { source: "imported", sourceUrl: `${URL_B}2`, sourceLicense: "Apache-2.0" });
  });

  it("leaves native cases alone: any number may have no link, and a link is not unique among them", async () => {
    const agent = await makeAgent();
    await insertCase(agent);
    await insertCase(agent);
    await insertCase(agent, { sourceUrl: "https://example.test/x" });
    await insertCase(agent, { sourceUrl: "https://example.test/x" });
  });

  it("does not let a native case's link block an imported one, or the other way round", async () => {
    const agent = await makeAgent();
    await insertCase(agent, { sourceUrl: `${URL_A}5` });
    await insertCase(agent, { source: "imported", sourceUrl: `${URL_A}5`, sourceLicense: "MIT" });
  });

  it("is a partial unique index on the source link", async () => {
    const rows = await t.sql(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'cases' and indexname = 'cases_imported_source_url_unique'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(rows[0].indexdef).toMatch(/source_url/);
    expect(rows[0].indexdef).toMatch(/imported/);
  });
});

describe("imported cases: a link and a licence are required", () => {
  it("refuses an imported case without a licence", async () => {
    const agent = await makeAgent();
    await expect(insertCase(agent, { source: "imported", sourceUrl: `${URL_A}7`, sourceLicense: null })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCase(agent, { source: "imported", sourceUrl: `${URL_A}7`, sourceLicense: null })).rejects.toThrow(/cases_imported_has_license/);
  });

  it("still refuses an imported case without a link", async () => {
    const agent = await makeAgent();
    await expect(insertCase(agent, { source: "imported", sourceUrl: null, sourceLicense: "MIT" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCase(agent, { source: "imported", sourceUrl: null, sourceLicense: "MIT" })).rejects.toThrow(/cases_imported_has_source_url/);
  });

  it("does not ask a native case for either", async () => {
    const agent = await makeAgent();
    await expect(insertCase(agent, { source: "native", sourceUrl: null, sourceLicense: null })).resolves.toHaveLength(1);
  });

  it("refuses to turn an existing native case into an imported one without both", async () => {
    const agent = await makeAgent();
    const [row] = await insertCase(agent);
    await expect(t.sql(`update cases set source = 'imported' where id = $1`, [row.id])).rejects.toMatchObject({ code: "23514" });
    await expect(t.sql(`update cases set source = 'imported', source_url = $2 where id = $1`, [row.id, `${URL_A}9`])).rejects.toMatchObject({ code: "23514" });
    await t.sql(`update cases set source = 'imported', source_url = $2, source_license = 'MIT' where id = $1`, [row.id, `${URL_A}9`]);
  });
});
