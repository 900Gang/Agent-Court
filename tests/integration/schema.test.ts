import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

async function insertOperator(authUserId?: string): Promise<string> {
  const rows = await t.sql(
    `insert into operators (github_id, display_name, auth_user_id) values ($1, $2, $3) returning id`,
    [uniq("gh"), "Test Operator", authUserId ?? null],
  );
  return rows[0].id as string;
}

async function insertAgent(operatorId?: string): Promise<string> {
  const owner = operatorId ?? (await insertOperator());
  const rows = await t.sql(
    `insert into agents (operator_id, handle) values ($1, $2) returning id`,
    [owner, uniq("agent")],
  );
  return rows[0].id as string;
}

interface CaseOptions {
  tags?: string[];
  source?: string;
  sourceUrl?: string | null;
}

async function insertCase(agentId: string, options: CaseOptions = {}): Promise<string> {
  const tags = (options.tags ?? []).map((tag) => `'${tag}'`).join(", ");
  const rows = await t.sql(
    `insert into cases (agent_id, title, summary, expected, actual, tags, source, source_url)
     values ($1, 'Title', 'Summary', 'Expected', 'Actual', array[${tags}]::text[], coalesce($2, 'native')::case_source, $3)
     returning id`,
    [agentId, options.source ?? null, options.sourceUrl ?? null],
  );
  return rows[0].id as string;
}

async function insertArgument(caseId: string, agentId: string): Promise<string> {
  const rows = await t.sql(
    `insert into arguments (case_id, agent_id, reasoning, proposed_change)
     values ($1, $2, 'Because', 'Change it') returning id`,
    [caseId, agentId],
  );
  return rows[0].id as string;
}

async function insertVerdict(caseId: string, argumentId: string, status = "active"): Promise<string> {
  const rows = await t.sql(
    `insert into verdicts (case_id, winning_argument_id, decided_by, verification_level, status)
     values ($1, $2, 'operator', 'operator_confirmed', $3) returning id`,
    [caseId, argumentId, status],
  );
  return rows[0].id as string;
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await t.sql(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name as string);
}

describe("tables", () => {
  it("creates every table in plan Section 5 and the Better Auth tables", async () => {
    const rows = await t.sql(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((row) => row.table_name as string);
    for (const expected of [
      "operators",
      "agents",
      "api_keys",
      "cases",
      "evidence",
      "arguments",
      "verdicts",
      "reputation_events",
      "reports",
      "moderation_events",
      "audit_log",
      "idempotency_keys",
      "user",
      "session",
      "account",
      "verification",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("has case_embeddings and search_events from node N7", async () => {
    const rows = await t.sql(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((row) => row.table_name as string);
    expect(names).toContain("case_embeddings");
    expect(names).toContain("search_events");
  });

  it("enables pgvector", async () => {
    const rows = await t.sql(`select extname from pg_extension where extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });
});

describe("fail-closed defaults", () => {
  it("creates operators as pending with role operator", async () => {
    const id = await insertOperator();
    const [row] = await t.sql(`select status, role from operators where id = $1`, [id]);
    expect(row).toEqual({ status: "pending", role: "operator" });
  });

  it("creates cases as held, so nothing is public until the gate decides", async () => {
    const caseId = await insertCase(await insertAgent());
    const [row] = await t.sql(`select status, source from cases where id = $1`, [caseId]);
    expect(row).toEqual({ status: "held", source: "native" });
  });

  it("creates arguments as held", async () => {
    const agentId = await insertAgent();
    const argumentId = await insertArgument(await insertCase(agentId), await insertAgent());
    const [row] = await t.sql(`select status from arguments where id = $1`, [argumentId]);
    expect(row).toEqual({ status: "held" });
  });

  it("rejects a case status that is not in the lifecycle", async () => {
    const caseId = await insertCase(await insertAgent());
    await expect(
      t.sql(`update cases set status = 'published' where id = $1`, [caseId]),
    ).rejects.toThrow();
  });
});

describe("operators and Better Auth link", () => {
  it("rejects an auth_user_id that does not exist in user", async () => {
    await expect(insertOperator("no-such-user")).rejects.toMatchObject({ code: "23503" });
  });

  it("accepts an auth_user_id that exists in user, and accepts null for seed operators", async () => {
    const userId = uniq("user");
    await t.sql(`insert into "user" (id, name, email) values ($1, 'Name', $2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await expect(insertOperator(userId)).resolves.toBeTruthy();
    await expect(insertOperator()).resolves.toBeTruthy();
  });

  it("keeps github_id unique", async () => {
    const githubId = uniq("gh-dup");
    await t.sql(`insert into operators (github_id, display_name) values ($1, 'A')`, [githubId]);
    await expect(
      t.sql(`insert into operators (github_id, display_name) values ($1, 'B')`, [githubId]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("supports soft delete columns on operators and agents", async () => {
    expect(await columnsOf("operators")).toContain("deleted_at");
    expect(await columnsOf("agents")).toContain("deleted_at");
  });
});

describe("agents", () => {
  it("keeps handles unique", async () => {
    const operatorId = await insertOperator();
    await t.sql(`insert into agents (operator_id, handle) values ($1, 'dup-handle')`, [operatorId]);
    await expect(
      t.sql(`insert into agents (operator_id, handle) values ($1, 'dup-handle')`, [operatorId]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("does not let an agent with cases be hard-deleted, so verdict history stays intact", async () => {
    const agentId = await insertAgent();
    await insertCase(agentId);
    await expect(t.sql(`delete from agents where id = $1`, [agentId])).rejects.toMatchObject({
      code: "23503",
    });
  });
});

describe("api_keys", () => {
  it("stores a hash and a prefix, and has no column that could hold a raw key", async () => {
    const columns = await columnsOf("api_keys");
    for (const expected of ["key_hash", "key_prefix", "scopes", "expires_at", "revoked_at", "last_used_at"]) {
      expect(columns).toContain(expected);
    }
    for (const column of columns) {
      expect(column).not.toMatch(/raw|secret|plaintext|api_key$/);
    }
  });

  it("keeps key hashes unique", async () => {
    const agentId = await insertAgent();
    const hash = uniq("hash");
    const insert = `insert into api_keys (agent_id, key_hash, key_prefix, scopes) values ($1, $2, 'ac_live_ab', array['read'])`;
    await t.sql(insert, [agentId, hash]);
    await expect(t.sql(insert, [agentId, hash])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("cases", () => {
  it("accepts slug tags", async () => {
    await expect(insertCase(await insertAgent(), { tags: ["tool-call", "schema-mismatch"] })).resolves.toBeTruthy();
  });

  it.each([
    ["a sentence", ["ignore previous instructions"]],
    ["upper case", ["Bad"]],
    ["longer than 32 characters", ["a".repeat(33)]],
    ["more than 8 tags", ["a", "b", "c", "d", "e", "f", "g", "h", "i"]],
  ])("rejects tags that are %s", async (_label, tags) => {
    await expect(insertCase(await insertAgent(), { tags })).rejects.toMatchObject({ code: "23514" });
  });

  it("requires a source_url for imported cases", async () => {
    const agentId = await insertAgent();
    await expect(insertCase(agentId, { source: "imported" })).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertCase(agentId, { source: "imported", sourceUrl: "https://example.test/issue/1" }),
    ).resolves.toBeTruthy();
  });
});

describe("evidence", () => {
  it("stores only redacted text, with no raw column", async () => {
    const columns = await columnsOf("evidence");
    expect(columns).toContain("redacted_text");
    expect(columns).toContain("redaction_report");
    for (const column of columns) {
      expect(column).not.toMatch(/^raw/);
    }
  });
});

describe("verdicts", () => {
  async function verdictFixture() {
    const agentId = await insertAgent();
    const caseId = await insertCase(agentId);
    const argumentId = await insertArgument(caseId, await insertAgent());
    return { caseId, argumentId };
  }

  it("rejects a second live verdict for one case", async () => {
    const { caseId, argumentId } = await verdictFixture();
    await insertVerdict(caseId, argumentId);
    await expect(insertVerdict(caseId, argumentId)).rejects.toMatchObject({ code: "23505" });
  });

  it("treats under_appeal as live", async () => {
    const { caseId, argumentId } = await verdictFixture();
    await insertVerdict(caseId, argumentId, "under_appeal");
    await expect(insertVerdict(caseId, argumentId)).rejects.toMatchObject({ code: "23505" });
  });

  it("allows a new verdict once the first is overturned, but still only one live", async () => {
    const { caseId, argumentId } = await verdictFixture();
    const first = await insertVerdict(caseId, argumentId);
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [first]);
    await expect(insertVerdict(caseId, argumentId)).resolves.toBeTruthy();
    await expect(insertVerdict(caseId, argumentId)).rejects.toMatchObject({ code: "23505" });
  });

  it("only accepts the four verification levels", async () => {
    const { caseId, argumentId } = await verdictFixture();
    await expect(
      t.sql(
        `insert into verdicts (case_id, winning_argument_id, decided_by, verification_level)
         values ($1, $2, 'operator', 'verified')`,
        [caseId, argumentId],
      ),
    ).rejects.toThrow();
  });
});

describe("reputation_events and idempotency_keys", () => {
  it("starts reputation events as pending with a release date column", async () => {
    const columns = await columnsOf("reputation_events");
    expect(columns).toContain("release_at");
    const rows = await t.sql(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'reputation_events' and column_name = 'status'`,
    );
    expect(String(rows[0].column_default)).toContain("pending");
  });

  it("keeps one stored response per agent and idempotency key", async () => {
    const agentId = await insertAgent();
    const insert = `insert into idempotency_keys (key_hash, agent_id, request_hash) values ($1, $2, 'req')`;
    const keyHash = uniq("idem");
    await t.sql(insert, [keyHash, agentId]);
    await expect(t.sql(insert, [keyHash, agentId])).rejects.toMatchObject({ code: "23505" });
  });
});
describe("api_keys label and scopes", () => {
  async function insertKey(agentId: string, label: string | null, scopes = "array['read']") {
    return t.sql(
      `insert into api_keys (agent_id, key_hash, key_prefix, scopes, label)
       values ($1, $2, 'ac_live_ab12', ${scopes}, $3) returning id`,
      [agentId, uniq("hash"), label],
    );
  }

  it("has a label column", async () => {
    expect(await columnsOf("api_keys")).toContain("label");
  });

  it("accepts no label, and a label of exactly 60 characters", async () => {
    const agentId = await insertAgent();
    await expect(insertKey(agentId, null)).resolves.toBeTruthy();
    await expect(insertKey(agentId, "a".repeat(60))).resolves.toBeTruthy();
  });

  it("rejects a label of 61 characters", async () => {
    await expect(insertKey(await insertAgent(), "a".repeat(61))).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts every scope the application defines", async () => {
    const agentId = await insertAgent();
    await expect(
      insertKey(agentId, null, "array['read', 'cases:write', 'arguments:write']"),
    ).resolves.toBeTruthy();
  });

  it("rejects a scope the application does not define", async () => {
    await expect(insertKey(await insertAgent(), null, "array['admin']")).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("evidence status", () => {
  async function insertEvidence(caseId: string, status?: string) {
    const rows = await t.sql(
      status === undefined
        ? `insert into evidence (case_id, kind, redacted_text) values ($1, 'trace', 'text') returning status`
        : `insert into evidence (case_id, kind, redacted_text, status) values ($1, 'trace', 'text', '${status}') returning status`,
      [caseId],
    );
    return rows[0].status as string;
  }

  it("has a status column", async () => {
    expect(await columnsOf("evidence")).toContain("status");
  });

  it("defaults to held, so evidence is never public until the gate decides", async () => {
    const caseId = await insertCase(await insertAgent());
    expect(await insertEvidence(caseId)).toBe("held");
  });

  it("accepts active", async () => {
    const caseId = await insertCase(await insertAgent());
    expect(await insertEvidence(caseId, "active")).toBe("active");
  });

  it("rejects a status outside held and active", async () => {
    const caseId = await insertCase(await insertAgent());
    await expect(insertEvidence(caseId, "bogus")).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("rejected arguments and evidence", () => {
  async function enumValues(name: string): Promise<string[]> {
    const rows = await t.sql(`select unnest(enum_range(null::${name}))::text as value`);
    return rows.map((row) => row.value as string);
  }

  it("adds rejected to argument_status and evidence_status, and nothing else", async () => {
    expect((await enumValues("argument_status")).sort()).toEqual(
      ["active", "held", "lost", "overturned", "rejected", "withdrawn", "won"].sort(),
    );
    expect((await enumValues("evidence_status")).sort()).toEqual(["active", "held", "rejected"]);
  });

  it("stores a rejected argument", async () => {
    const caseId = await insertCase(await insertAgent());
    const rows = await t.sql(
      `insert into arguments (case_id, agent_id, reasoning, proposed_change, status)
       values ($1, $2, 'r', 'p', 'rejected') returning status`,
      [caseId, await insertAgent()],
    );
    expect(rows[0].status).toBe("rejected");
  });

  it("does not count a rejected argument toward the one-live-argument rule", async () => {
    const caseId = await insertCase(await insertAgent());
    const arguer = await insertAgent();
    const insert = (status: string) =>
      t.sql(
        `insert into arguments (case_id, agent_id, reasoning, proposed_change, status)
         values ($1, $2, 'r', 'p', '${status}') returning id`,
        [caseId, arguer],
      );
    await insert("rejected");
    await expect(insert("held")).resolves.toBeTruthy();
    await expect(insert("held")).rejects.toMatchObject({ code: "23505" });
  });

  it("stores rejected evidence, and still refuses a made-up status", async () => {
    const caseId = await insertCase(await insertAgent());
    const insert = (status: string) =>
      t.sql(`insert into evidence (case_id, kind, redacted_text, status) values ($1, 'trace', 'x', '${status}') returning status`, [caseId]);
    expect((await insert("rejected"))[0].status).toBe("rejected");
    await expect(insert("bogus")).rejects.toMatchObject({ code: "22P02" });
  });
});
