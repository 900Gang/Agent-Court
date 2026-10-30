import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbChecks, type CheckResult } from "@/scripts/live-db-check";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

const owner = (query: string) => t.sql(query);

async function app(query: string) {
  await t.sql("set role app_server");
  try {
    return await t.sql(query);
  } finally {
    await t.sql("reset role");
  }
}

const failing = (results: CheckResult[]) => results.filter((r) => !r.ok).map((r) => r.name);

async function expectOnlyFailure(name: string, apply: string, revert: string) {
  await t.pg.exec(apply);
  try {
    expect(failing(await runDbChecks(owner, app))).toEqual([name]);
  } finally {
    await t.pg.exec(revert);
  }
}

describe("runDbChecks on a correctly migrated database", () => {
  it("passes every check", async () => {
    const results = await runDbChecks(owner, app);
    expect(results.length).toBeGreaterThanOrEqual(11);
    expect(failing(results)).toEqual([]);
  });
});

describe("runDbChecks detects each defect", () => {
  it("a table without forced RLS", () =>
    expectOnlyFailure(
      "RLS is enabled and forced on every table",
      "alter table cases no force row level security",
      "alter table cases force row level security",
    ));

  it("a policy for a role other than app_server", () =>
    expectOnlyFailure(
      "every table has one policy, for app_server only",
      "create policy leak on operators for select to public using (true)",
      "drop policy leak on operators",
    ));

  it("a PUBLIC privilege on a table", () =>
    expectOnlyFailure(
      "PUBLIC holds no table privileges",
      "grant select on cases to public",
      "revoke select on cases from public",
    ));

  it("PUBLIC access to the public schema", () =>
    expectOnlyFailure(
      "PUBLIC cannot use the public schema",
      "grant usage on schema public to public",
      "revoke usage on schema public from public",
    ));

  it("a missing pgvector extension", () =>
    expectOnlyFailure(
      "pgvector is installed",
      // The embeddings table depends on the extension, so dropping it takes the vector column and its index along.
      "drop extension vector cascade",
      `create extension vector;
       alter table case_embeddings add column embedding vector(1536) not null;
       create index case_embeddings_embedding_hnsw on case_embeddings using hnsw (embedding vector_cosine_ops);`,
    ));

  it("a missing verdict lock trigger", () =>
    expectOnlyFailure(
      "verdict lock trigger exists",
      "drop trigger arguments_lock_won on arguments",
      `create trigger arguments_lock_won before update of status on arguments
       for each row execute function arguments_lock_won()`,
    ));

  it("app_server being able to update audit_log", () =>
    expectOnlyFailure(
      "app_server cannot update audit_log",
      "grant update on audit_log to app_server",
      "revoke update on audit_log from app_server",
    ));

  it("app_server being able to delete verdicts", () =>
    expectOnlyFailure(
      "app_server cannot delete from verdicts",
      "grant delete on verdicts to app_server",
      "revoke delete on verdicts from app_server",
    ));

  it("a stored provider token", () =>
    expectOnlyFailure(
      "no provider tokens are stored",
      `insert into "user" (id, name, email) values ('u-live', 'N', 'live@example.test');
       insert into account (id, account_id, provider_id, user_id, access_token)
       values ('a-live', '1', 'github', 'u-live', 'gho_x');`,
      `delete from account where id = 'a-live'; delete from "user" where id = 'u-live';`,
    ));

  it("reports every failure, not just the first", async () => {
    await t.pg.exec("grant select on cases to public; grant delete on verdicts to app_server;");
    try {
      expect(failing(await runDbChecks(owner, app)).sort()).toEqual(
        ["PUBLIC holds no table privileges", "app_server cannot delete from verdicts"].sort(),
      );
    } finally {
      await t.pg.exec("revoke select on cases from public; revoke delete on verdicts from app_server;");
    }
  });

  it("notices when the application connects as the wrong role", async () => {
    expect(failing(await runDbChecks(owner, owner))).toContain("connected as app_server");
  });
});
