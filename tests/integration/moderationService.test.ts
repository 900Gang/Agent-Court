import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordModeration } from "@/lib/services/moderationService";
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

describe("recordModeration", () => {
  it("stores a decision with its target", async () => {
    const targetId = crypto.randomUUID();
    await recordModeration(t.db, {
      targetType: "case",
      targetId,
      check: "injection",
      result: "flag",
      details: { stub: true },
    });
    const [row] = await t.sql(
      `select target_type, target_id, "check", result, details from moderation_events where target_id = $1`,
      [targetId],
    );
    expect(row).toMatchObject({ target_type: "case", target_id: targetId, check: "injection", result: "flag" });
    expect(row.details).toEqual({ stub: true });
  });

  it("stores a null target for content that was blocked and never saved", async () => {
    await recordModeration(t.db, { targetType: "argument", targetId: null, check: "redaction", result: "block" });
    const rows = await t.sql(
      `select details from moderation_events where target_type = 'argument' and target_id is null and result = 'block'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({});
  });

  it("scrubs secrets from details before storing them", async () => {
    const targetId = crypto.randomUUID();
    await recordModeration(t.db, {
      targetType: "evidence",
      targetId,
      check: "redaction",
      result: "pass",
      details: { note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", token: "plain-secret-value" },
    });
    const [row] = await t.sql(`select details::text as text from moderation_events where target_id = $1`, [targetId]);
    expect(row.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(row.text).not.toContain("plain-secret-value");
  });

  it("cannot be updated afterwards, because the table is append-only", async () => {
    await expect(t.sql(`update moderation_events set result = 'pass'`)).rejects.toMatchObject({ code: "42501" });
  });
});
