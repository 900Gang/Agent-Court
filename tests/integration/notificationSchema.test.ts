import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const denied = { code: "42501" };
const UUID_A = "00000000-0000-4000-8000-0000000000a1";
const UUID_B = "00000000-0000-4000-8000-0000000000b2";

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

async function makeOperator(): Promise<string> {
  const [operator] = await t.sql(`insert into operators (github_id, display_name) values ($1, 'Op') returning id`, [uniq("gh")]);
  return operator.id as string;
}

const claim = (kind: string, target: string, operator: string) =>
  t.sql(`insert into notification_log (kind, target_id, operator_id) values ($1, $2, $3) returning id, created_at`, [kind, target, operator]);

describe("notification_log: the table", () => {
  it("has the columns the notice job uses", async () => {
    const rows = await t.sql(
      `select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'notification_log' order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "id", is_nullable: "NO" },
      { column_name: "kind", is_nullable: "NO" },
      { column_name: "operator_id", is_nullable: "NO" },
      { column_name: "target_id", is_nullable: "NO" },
    ]);
  });

  it("stamps the time itself", async () => {
    const operator = await makeOperator();
    const [row] = await claim("reminder_3", UUID_A, operator);
    expect(row.created_at).toBeTruthy();
  });

  it("refuses an operator that does not exist", async () => {
    await expect(claim("reminder_3", UUID_A, "00000000-0000-4000-8000-00000000dead")).rejects.toMatchObject({ code: "23503" });
  });
});

describe("notification_log: one claim per notice", () => {
  it("refuses a second claim for the same kind, target and operator", async () => {
    const operator = await makeOperator();
    await claim("new_argument", UUID_A, operator);
    await expect(claim("new_argument", UUID_A, operator)).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same notice to another operator, another kind, or another target", async () => {
    const one = await makeOperator();
    const two = await makeOperator();
    await claim("case_closed", UUID_A, one);
    await claim("case_closed", UUID_A, two);
    await claim("appeal_outcome", UUID_A, one);
    await claim("case_closed", UUID_B, one);
  });

  it("gives a claim back when it is deleted, so the notice can be claimed again", async () => {
    const operator = await makeOperator();
    const [first] = await claim("reminder_7", UUID_B, operator);
    await t.sql(`delete from notification_log where id = $1`, [first.id]);
    await claim("reminder_7", UUID_B, operator);
  });
});

describe("notification_log: what the application role may do", () => {
  it("can insert, read and delete, and cannot update", async () => {
    const operator = await makeOperator();
    await asRole("app_server", async () => {
      const [row] = await claim("reminder_12", UUID_A, operator);
      expect((await t.sql(`select kind from notification_log where id = $1`, [row.id]))[0].kind).toBe("reminder_12");
      await expect(t.sql(`update notification_log set kind = 'x' where id = $1`, [row.id])).rejects.toMatchObject(denied);
      await expect(t.sql(`delete from notification_log where id = $1`, [row.id])).resolves.toBeDefined();
    });
  });
});

describe("notification_log: security", () => {
  it("has row level security enabled and forced", async () => {
    const [row] = await t.sql(`select relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'notification_log'`);
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("has exactly one policy, for app_server only", async () => {
    const rows = await t.sql(`select roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'notification_log'`);
    expect(rows).toEqual([{ roles: "{app_server}" }]);
  });

  it("gives PUBLIC no privileges", async () => {
    const rows = await t.sql(
      `select a.privilege_type from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relname = 'notification_log' and a.grantee = 0`,
    );
    expect(rows).toEqual([]);
  });

  it("is closed to a role with no grants", async () => {
    await expect(asRole("nobody", () => t.sql(`select count(*) from public."notification_log"`))).rejects.toMatchObject(denied);
    await expect(asRole("nobody", () => t.sql(`insert into public."notification_log" default values`))).rejects.toMatchObject(denied);
  });
});
