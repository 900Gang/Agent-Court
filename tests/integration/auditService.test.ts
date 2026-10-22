import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/services/auditService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

describe("writeAudit with an agent actor", () => {
  it.each(["case.filed", "case.withdrawn", "evidence.added", "argument.submitted", "argument.withdrawn"] as const)(
    "records %s attributed to the agent",
    async (action) => {
      const agentId = crypto.randomUUID();
      const target = crypto.randomUUID();
      await writeAudit(t.db, { actorType: "agent", actorId: agentId, action, target, metadata: { caseId: target } });
      const [row] = await t.sql(`select actor_type, actor_id, action, target, metadata from audit_log where target = $1`, [target]);
      expect(row).toMatchObject({ actor_type: "agent", actor_id: agentId, action, target });
      expect(row.metadata).toEqual({ caseId: target });
    },
  );

  it("still records operator actions", async () => {
    const operatorId = crypto.randomUUID();
    const target = crypto.randomUUID();
    await writeAudit(t.db, { actorType: "operator", actorId: operatorId, action: "key.revoked", target });
    const [row] = await t.sql(`select actor_type, actor_id from audit_log where target = $1`, [target]);
    expect(row).toMatchObject({ actor_type: "operator", actor_id: operatorId });
  });
});
