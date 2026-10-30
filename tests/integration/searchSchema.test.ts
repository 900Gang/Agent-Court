import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const denied = { code: "42501" };

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await t.sql(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await t.sql("reset role");
  }
}

/** A vector literal of the given length: the first value is `lead`, the rest are zero. */
const vec = (lead = 1, dims = 1536) => `[${[lead, ...Array(dims - 1).fill(0)].join(",")}]`;

async function makeAgent(): Promise<string> {
  const [operator] = await t.sql(`insert into operators (github_id, display_name) values ($1, 'Op') returning id`, [uniq("gh")]);
  const [agent] = await t.sql(`insert into agents (operator_id, handle) values ($1, $2) returning id`, [operator.id, uniq("agent")]);
  return agent.id as string;
}

async function makeCase(agentId: string, over: { title?: string; summary?: string; expected?: string; actual?: string; tags?: string[] } = {}): Promise<string> {
  const [row] = await t.sql(
    `insert into cases (agent_id, title, summary, expected, actual, tags, status)
     values ($1, $2, $3, $4, $5, $6, 'open') returning id`,
    [agentId, over.title ?? "T", over.summary ?? "S", over.expected ?? "E", over.actual ?? "A", over.tags ?? []],
  );
  return row.id as string;
}

const insertEmbedding = (caseId: string, model = "model-a", embedding = vec(), hash = "hash-1") =>
  t.sql(`insert into case_embeddings (case_id, model, dim, embedding, text_hash) values ($1, $2, 1536, $3::vector, $4) returning id`, [
    caseId,
    model,
    embedding,
    hash,
  ]);

describe("case_embeddings", () => {
  it("has the agreed columns, and the vector column is a vector", async () => {
    const rows = await t.sql(
      `select column_name, udt_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'case_embeddings' order by column_name`,
    );
    const byName = Object.fromEntries(rows.map((row) => [row.column_name as string, row]));
    expect(Object.keys(byName).sort()).toEqual(["case_id", "created_at", "dim", "embedding", "id", "model", "text_hash"]);
    expect(byName.embedding.udt_name).toBe("vector");
    for (const column of ["case_id", "model", "dim", "embedding", "text_hash"]) {
      expect(byName[column].is_nullable, column).toBe("NO");
    }
  });

  it("lets app_server insert, read and update a row, and not delete one", async () => {
    const caseId = await makeCase(await makeAgent());
    await asRole("app_server", () => insertEmbedding(caseId));
    const rows = await asRole("app_server", () => t.sql(`select model, dim, text_hash from case_embeddings where case_id = $1`, [caseId]));
    expect(rows).toEqual([{ model: "model-a", dim: 1536, text_hash: "hash-1" }]);
    await asRole("app_server", () => t.sql(`update case_embeddings set text_hash = 'hash-2', embedding = $2::vector where case_id = $1`, [caseId, vec(2)]));
    const [updated] = await t.sql(`select text_hash from case_embeddings where case_id = $1`, [caseId]);
    expect(updated.text_hash).toBe("hash-2");
    await expect(asRole("app_server", () => t.sql(`delete from case_embeddings where false`))).rejects.toMatchObject(denied);
  });

  it("allows one row per case and model, and another model for the same case", async () => {
    const caseId = await makeCase(await makeAgent());
    await insertEmbedding(caseId, "model-a");
    await expect(insertEmbedding(caseId, "model-a")).rejects.toMatchObject({ code: "23505" });
    await insertEmbedding(caseId, "model-b");
    const [count] = await t.sql(`select count(*)::int as n from case_embeddings where case_id = $1`, [caseId]);
    expect(count.n).toBe(2);
  });

  it("rejects a vector of the wrong length and a case that does not exist", async () => {
    const caseId = await makeCase(await makeAgent());
    await expect(insertEmbedding(caseId, "model-short", "[1,2,3]")).rejects.toThrow(/1536/);
    await expect(insertEmbedding(crypto.randomUUID(), "model-x")).rejects.toMatchObject({ code: "23503" });
  });

  it("has an HNSW index with cosine distance on the vector column", async () => {
    const rows = await t.sql(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'case_embeddings'`);
    const definitions = rows.map((row) => String(row.indexdef));
    expect(definitions.some((definition) => /USING hnsw/i.test(definition) && /vector_cosine_ops/.test(definition) && /embedding/.test(definition))).toBe(true);
  });

  it("finds the nearest vector by cosine distance", async () => {
    const agent = await makeAgent();
    const near = await makeCase(agent);
    const far = await makeCase(agent);
    const nearVector = `[${[1, 0.1, ...Array(1534).fill(0)].join(",")}]`;
    const farVector = `[${[0, 1, ...Array(1534).fill(0)].join(",")}]`;
    await insertEmbedding(near, "model-nn", nearVector);
    await insertEmbedding(far, "model-nn", farVector);
    const rows = await t.sql(
      `select case_id from case_embeddings where model = 'model-nn' order by embedding <=> $1::vector limit 1`,
      [vec(1)],
    );
    expect(rows[0].case_id).toBe(near);
  });
});

describe("search_events", () => {
  it("has the agreed columns", async () => {
    const rows = await t.sql(
      `select column_name, udt_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'search_events' order by column_name`,
    );
    const byName = Object.fromEntries(rows.map((row) => [row.column_name as string, row]));
    expect(Object.keys(byName).sort()).toEqual(["agent_id", "created_at", "id", "query_redacted", "resolved_hit", "result_count"]);
    expect(byName.agent_id.is_nullable).toBe("YES");
    for (const column of ["query_redacted", "result_count", "resolved_hit"]) expect(byName[column].is_nullable, column).toBe("NO");
    expect(byName.result_count.udt_name).toBe("int4");
    expect(byName.resolved_hit.udt_name).toBe("bool");
  });

  it("is append-only for app_server: insert and select, never update or delete", async () => {
    const agentId = await makeAgent();
    await asRole("app_server", () =>
      t.sql(`insert into search_events (agent_id, query_redacted, result_count, resolved_hit) values ($1, 'retry loop', 3, true)`, [agentId]),
    );
    const rows = await asRole("app_server", () => t.sql(`select query_redacted, result_count, resolved_hit from search_events where agent_id = $1`, [agentId]));
    expect(rows).toEqual([{ query_redacted: "retry loop", result_count: 3, resolved_hit: true }]);
    await expect(asRole("app_server", () => t.sql(`update search_events set result_count = 0 where false`))).rejects.toMatchObject(denied);
    await expect(asRole("app_server", () => t.sql(`delete from search_events where false`))).rejects.toMatchObject(denied);
  });

  it("accepts a missing agent and refuses an agent that does not exist", async () => {
    await t.sql(`insert into search_events (query_redacted, result_count, resolved_hit) values ('no agent', 0, false)`);
    await expect(
      t.sql(`insert into search_events (agent_id, query_redacted, result_count, resolved_hit) values ($1, 'x', 0, false)`, [crypto.randomUUID()]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("holds at most 200 characters of query", async () => {
    await t.sql(`insert into search_events (query_redacted, result_count, resolved_hit) values ($1, 0, false)`, ["a".repeat(200)]);
    await expect(
      t.sql(`insert into search_events (query_redacted, result_count, resolved_hit) values ($1, 0, false)`, ["a".repeat(201)]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("needs a result count and a resolved flag, and stamps the time itself", async () => {
    await expect(t.sql(`insert into search_events (query_redacted) values ('x')`)).rejects.toMatchObject({ code: "23502" });
    const [row] = await t.sql(`insert into search_events (query_redacted, result_count, resolved_hit) values ('x', 1, false) returning created_at`);
    expect(row.created_at).toBeTruthy();
  });
});

describe("security of the new tables", () => {
  const tables = ["case_embeddings", "search_events"];

  it.each(tables)("%s has row level security enabled and forced", async (table) => {
    const [row] = await t.sql(`select relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = $1`, [table]);
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(tables)("%s has exactly one policy, for app_server only", async (table) => {
    const rows = await t.sql(`select roles::text as roles from pg_policies where schemaname = 'public' and tablename = $1`, [table]);
    expect(rows).toEqual([{ roles: "{app_server}" }]);
  });

  it.each(tables)("%s gives PUBLIC no privileges", async (table) => {
    const rows = await t.sql(
      `select a.privilege_type from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relname = $1 and a.grantee = 0`,
      [table],
    );
    expect(rows).toEqual([]);
  });

  it.each(tables)("%s is closed to a role with no grants", async (table) => {
    await expect(asRole("nobody", () => t.sql(`select count(*) from public."${table}"`))).rejects.toMatchObject(denied);
    await expect(asRole("nobody", () => t.sql(`insert into public."${table}" default values`))).rejects.toMatchObject(denied);
  });
});

describe("full-text search column on cases", () => {
  const find = async (query: string) =>
    (await t.sql(`select id from cases where search_tsv @@ websearch_to_tsquery('english', $1)`, [query])).map((row) => row.id as string);

  it("is a generated tsvector column with a GIN index", async () => {
    const [column] = await t.sql(
      `select udt_name, is_generated from information_schema.columns where table_schema = 'public' and table_name = 'cases' and column_name = 'search_tsv'`,
    );
    expect(column).toEqual({ udt_name: "tsvector", is_generated: "ALWAYS" });
    const indexes = await t.sql(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'cases'`);
    expect(indexes.some((row) => /USING gin/i.test(String(row.indexdef)) && /search_tsv/.test(String(row.indexdef)))).toBe(true);
  });

  it("matches on title, summary, expected, actual and tags, with stemming", async () => {
    const agent = await makeAgent();
    const byTitle = await makeCase(agent, { title: "Aardvark retries forever" });
    const bySummary = await makeCase(agent, { summary: "The platypus keeps looping" });
    const byExpected = await makeCase(agent, { expected: "A wombat answer is expected" });
    const byActual = await makeCase(agent, { actual: "A quokka crash happened" });
    const byTag = await makeCase(agent, { tags: ["zebra-crash"] });
    expect(await find("retry aardvark")).toContain(byTitle);
    expect(await find("platypus loop")).toContain(bySummary);
    expect(await find("wombat")).toContain(byExpected);
    expect(await find("quokka")).toContain(byActual);
    expect(await find("zebra")).toContain(byTag);
  });

  it("follows an update of the text", async () => {
    const id = await makeCase(await makeAgent(), { title: "Narwhal timeout storm" });
    expect(await find("narwhal")).toContain(id);
    await t.sql(`update cases set title = 'Pangolin cache miss' where id = $1`, [id]);
    expect(await find("narwhal")).not.toContain(id);
    expect(await find("pangolin")).toContain(id);
  });

  it("does not match a word that is not there", async () => {
    await makeCase(await makeAgent(), { title: "Ordinary case" });
    expect(await find("xyzzyplugh")).toEqual([]);
  });
});
