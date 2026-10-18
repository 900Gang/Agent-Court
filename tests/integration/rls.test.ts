import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let tables: string[] = [];
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;

beforeAll(async () => {
  t = await createTestDb();
  const rows = await t.sql(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  tables = rows.map((row) => row.tablename as string);
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

const denied = { code: "42501" };

async function insertArgument(): Promise<string> {
  const [operator] = await t.sql(
    `insert into operators (github_id, display_name) values ($1, 'Op') returning id`,
    [uniq("gh")],
  );
  const [agent] = await t.sql(
    `insert into agents (operator_id, handle) values ($1, $2) returning id`,
    [operator.id, uniq("agent")],
  );
  const [caseRow] = await t.sql(
    `insert into cases (agent_id, title, summary, expected, actual) values ($1, 'T', 'S', 'E', 'A') returning id`,
    [agent.id],
  );
  const [argument] = await t.sql(
    `insert into arguments (case_id, agent_id, reasoning, proposed_change)
     values ($1, $2, 'Reasoning', 'Change') returning id`,
    [caseRow.id, agent.id],
  );
  return argument.id as string;
}

describe("row level security", () => {
  it("covers every table in the public schema", () => {
    expect(tables.length).toBeGreaterThanOrEqual(16);
  });

  it("is enabled and forced on every table", async () => {
    const rows = await t.sql(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows.length).toBe(tables.length);
    for (const row of rows) {
      expect(row, `table ${row.relname}`).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it("has exactly one policy per table, and it belongs to app_server only", async () => {
    const rows = await t.sql(
      `select tablename, roles::text as roles from pg_policies where schemaname = 'public'`,
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([...tables].sort());
    for (const row of rows) {
      expect(row.roles, `policy on ${row.tablename}`).toBe("{app_server}");
    }
  });

  it("denies a role that is granted access later but has no policy", async () => {
    await t.sql(`insert into operators (github_id, display_name) values ($1, 'Visible')`, [
      uniq("gh"),
    ]);
    await t.sql(`create role probe nologin`);
    await t.sql(`grant usage on schema public to probe`);
    await t.sql(`grant select on operators to probe`);

    const [asOwner] = await t.sql(`select count(*)::int as n from operators`);
    expect(asOwner.n).toBeGreaterThan(0);

    const [asProbe] = await asRole("probe", () => t.sql(`select count(*)::int as n from operators`));
    expect(asProbe.n).toBe(0);
  });
});

describe("grants", () => {
  it("gives PUBLIC no privileges on any table", async () => {
    const rows = await t.sql(
      `select c.relname from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.grantee = 0`,
    );
    expect(rows).toEqual([]);
  });

  it("removes PUBLIC access to the public schema and allows only app_server to use it", async () => {
    const [nobody] = await t.sql(
      `select has_schema_privilege('nobody', 'public', 'USAGE') as usage,
              has_schema_privilege('nobody', 'public', 'CREATE') as create_`,
    );
    expect(nobody).toEqual({ usage: false, create_: false });

    const [app] = await t.sql(
      `select has_schema_privilege('app_server', 'public', 'USAGE') as usage,
              has_schema_privilege('app_server', 'public', 'CREATE') as create_`,
    );
    expect(app).toEqual({ usage: true, create_: false });
  });

  it("lets a role with no grants neither read nor write any table", async () => {
    for (const table of tables) {
      await expect(
        asRole("nobody", () => t.sql(`select count(*) from public."${table}"`)),
        `select on ${table}`,
      ).rejects.toMatchObject(denied);
      await expect(
        asRole("nobody", () => t.sql(`insert into public."${table}" default values`)),
        `insert on ${table}`,
      ).rejects.toMatchObject(denied);
    }
  });

  it("lets app_server read and write operators", async () => {
    const githubId = uniq("gh-app");
    await asRole("app_server", () =>
      t.sql(`insert into operators (github_id, display_name) values ($1, 'Via app role')`, [githubId]),
    );
    const rows = await asRole("app_server", () =>
      t.sql(`select display_name from operators where github_id = $1`, [githubId]),
    );
    expect(rows).toEqual([{ display_name: "Via app role" }]);
  });

  it.each(["audit_log", "moderation_events"])(
    "makes %s append-only for app_server",
    async (table) => {
      await expect(
        asRole("app_server", () => t.sql(`update ${table} set created_at = now() where false`)),
      ).rejects.toMatchObject(denied);
      await expect(
        asRole("app_server", () => t.sql(`delete from ${table} where false`)),
      ).rejects.toMatchObject(denied);
      await expect(asRole("app_server", () => t.sql(`select * from ${table}`))).resolves.toBeDefined();
    },
  );

  it("lets app_server append to audit_log and moderation_events", async () => {
    await asRole("app_server", () =>
      t.sql(`insert into audit_log (actor_type, action) values ('system', 'test')`),
    );
    await asRole("app_server", () =>
      t.sql(
        `insert into moderation_events (target_type, "check", result) values ('case', 'redaction', 'pass')`,
      ),
    );
  });

  it.each([
    "cases",
    "arguments",
    "verdicts",
    "evidence",
    "agents",
    "operators",
    "api_keys",
    "reputation_events",
    "reports",
  ])("never lets app_server delete from %s", async (table) => {
    await expect(
      asRole("app_server", () => t.sql(`delete from ${table} where false`)),
    ).rejects.toMatchObject(denied);
  });

  it.each(["session", "verification", "account", "idempotency_keys"])(
    "lets app_server delete from %s",
    async (table) => {
      await expect(
        asRole("app_server", () => t.sql(`delete from ${table} where false`)),
      ).resolves.toBeDefined();
    },
  );
});

describe("winning arguments", () => {
  async function wonArgument(): Promise<string> {
    const id = await insertArgument();
    await t.sql(`update arguments set status = 'won' where id = $1`, [id]);
    return id;
  }

  it("cannot be withdrawn after the verdict", async () => {
    const id = await wonArgument();
    const attempt = t.sql(`update arguments set status = 'withdrawn' where id = $1`, [id]);
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
    await expect(attempt).rejects.toThrow(/verdict_locked/);
  });

  it("can still be overturned by an admin", async () => {
    const id = await wonArgument();
    await t.sql(`update arguments set status = 'overturned' where id = $1`, [id]);
    const [row] = await t.sql(`select status from arguments where id = $1`, [id]);
    expect(row.status).toBe("overturned");
  });

  it("can still have its text redacted", async () => {
    const id = await wonArgument();
    await t.sql(`update arguments set reasoning = '[REDACTED:secret]' where id = $1`, [id]);
    const [row] = await t.sql(`select reasoning, status from arguments where id = $1`, [id]);
    expect(row).toEqual({ reasoning: "[REDACTED:secret]", status: "won" });
  });

  it("does not block withdrawing an argument that has not won", async () => {
    const id = await insertArgument();
    await t.sql(`update arguments set status = 'active' where id = $1`, [id]);
    await t.sql(`update arguments set status = 'withdrawn' where id = $1`, [id]);
    const [row] = await t.sql(`select status from arguments where id = $1`, [id]);
    expect(row.status).toBe("withdrawn");
  });
});