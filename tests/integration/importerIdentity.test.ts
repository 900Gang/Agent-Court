import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPORT, isReservedHandle } from "@/lib/config/constants";
import { createAgent } from "@/lib/services/agentService";
import { ensureImporter } from "@/lib/import/identity";
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

const operatorRows = () => f.count("operators where github_id = $1", [IMPORT.operatorGithubId]);
const agentRows = () => f.count("agents where handle = $1", [IMPORT.handle]);

describe("ensureImporter", () => {
  it("creates the reserved operator and the importer agent, and answers with their ids", async () => {
    const importer = await ensureImporter(t.db);
    expect(importer.operatorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(importer.agentId).toMatch(/^[0-9a-f-]{36}$/);

    const [operator] = await t.sql(`select github_id, display_name, role, status, email, auth_user_id, deleted_at from operators where id = $1`, [importer.operatorId]);
    expect(operator).toEqual({
      github_id: IMPORT.operatorGithubId,
      display_name: IMPORT.operatorName,
      role: "operator",
      status: "active",
      email: null,
      auth_user_id: null,
      deleted_at: null,
    });
    const [agent] = await t.sql(`select handle, operator_id, status, deleted_at from agents where id = $1`, [importer.agentId]);
    expect(agent).toEqual({ handle: IMPORT.handle, operator_id: importer.operatorId, status: "active", deleted_at: null });
  });

  it("is idempotent: the same ids, and no second row", async () => {
    const first = await ensureImporter(t.db);
    const second = await ensureImporter(t.db);
    expect(second).toEqual(first);
    expect(await operatorRows()).toBe(1);
    expect(await agentRows()).toBe(1);
  });

  it("makes one of each when two calls run at once", async () => {
    await t.sql("reset role");
    await t.sql("truncate operators cascade");
    await t.sql("set role app_server");
    const [a, b] = await Promise.all([ensureImporter(t.db), ensureImporter(t.db)]);
    expect(a).toEqual(b);
    expect(await operatorRows()).toBe(1);
    expect(await agentRows()).toBe(1);
  });

  it("never creates an API key, so the importer cannot authenticate", async () => {
    const importer = await ensureImporter(t.db);
    expect(await f.count("api_keys where agent_id = $1", [importer.agentId])).toBe(0);
  });

  it("uses an id that cannot be a GitHub id, so no one can sign in as the operator", async () => {
    expect(IMPORT.operatorGithubId).not.toMatch(/^\d+$/);
    const importer = await ensureImporter(t.db);
    const [operator] = await t.sql(`select github_id, auth_user_id from operators where id = $1`, [importer.operatorId]);
    expect(operator.github_id).not.toMatch(/^\d+$/);
    expect(operator.auth_user_id).toBeNull();
  });

  it("writes no reputation, no case and no audit row", async () => {
    const before = { events: await f.count("reputation_events"), cases: await f.count("cases"), audit: await f.count("audit_log") };
    await ensureImporter(t.db);
    expect({ events: await f.count("reputation_events"), cases: await f.count("cases"), audit: await f.count("audit_log") }).toEqual(before);
  });

  it("leaves a suspended importer suspended: it creates, it never reactivates", async () => {
    const importer = await ensureImporter(t.db);
    await t.sql("reset role");
    await t.sql(`update agents set status = 'suspended' where id = $1`, [importer.agentId]);
    await t.sql("set role app_server");
    expect(await ensureImporter(t.db)).toEqual(importer);
    expect((await t.sql(`select status from agents where id = $1`, [importer.agentId]))[0].status).toBe("suspended");
    await t.sql("reset role");
    await t.sql(`update agents set status = 'active' where id = $1`, [importer.agentId]);
    await t.sql("set role app_server");
  });
});

describe("the reserved handle", () => {
  it("is reserved, so no one can register it", async () => {
    expect(isReservedHandle(IMPORT.handle)).toBe(true);
    const operator = await f.makeOperator();
    const result = await createAgent(t.db, operator, { handle: IMPORT.handle });
    expect(result.ok).toBe(false);
    expect(await agentRows()).toBe(1);
  });

  it("is reserved in every capitalisation", async () => {
    const operator = await f.makeOperator();
    for (const handle of ["Importer", "IMPORTER", "importer"]) {
      expect((await createAgent(t.db, operator, { handle })).ok).toBe(false);
    }
  });
});
