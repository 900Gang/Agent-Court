import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argumentsTable, evidence as evidenceTable, operators, type Operator } from "@/db/schema";
import { applyRedaction, REDACTION_PLACEHOLDER } from "@/lib/services/redactionService";
import { issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";
const P = REDACTION_PLACEHOLDER;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeAdmin(status: "active" | "pending" | "suspended" = "active", role: "admin" | "operator" = "admin"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role, status }).returning();
  return row;
}

/** A public case with text to redact, one evidence item and one argument, all carrying the marker MARK_a. */
async function setup(caseStatus: "open" | "held" = "open") {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, {
    status: caseStatus,
    title: "Title with MARK_a inside",
    summary: "Summary MARK_a and MARK_a again",
    expected: "Expected MARK_a",
    actual: "Actual text",
  });
  const [evidence] = await t.db.insert(evidenceTable).values({ caseId: c.id, kind: "trace", status: "active", redactedText: "trace MARK_a here" }).returning();
  const author = await f.makeAgent();
  const [argument] = await t.db
    .insert(argumentsTable)
    .values({ caseId: c.id, agentId: author.actor.agentId, status: "active", reasoning: "Reasoning MARK_a here", proposedChange: "Change MARK_a here" })
    .returning();
  return { filer, c, evidence, argument, author };
}

type Kind = "case" | "evidence" | "argument";
const COLUMN: Record<string, string> = { title: "title", summary: "summary", expected: "expected", actual: "actual", text: "redacted_text", reasoning: "reasoning", proposedChange: "proposed_change" };
const TABLE: Record<Kind, string> = { case: "cases", evidence: "evidence", argument: "arguments" };

const read = async (kind: Kind, id: string, field: string) => (await t.sql(`select ${COLUMN[field]} as v from ${TABLE[kind]} where id = $1`, [id]))[0].v as string;

const redact = (admin: Operator, input: Record<string, unknown>, at: Date = NOW) => applyRedaction(t.db, admin, input, at);

async function counts() {
  return {
    audit: await f.count("audit_log where action = 'redaction.applied'"),
    moderation: await f.count("moderation_events where details ->> 'action' = 'redact'"),
    events: await f.count("reputation_events"),
  };
}

const TARGETS: Array<[Kind, string]> = [
  ["case", "title"],
  ["case", "summary"],
  ["case", "expected"],
  ["case", "actual"],
  ["evidence", "text"],
  ["argument", "reasoning"],
  ["argument", "proposedChange"],
];

function idOf(kind: Kind, s: Awaited<ReturnType<typeof setup>>) {
  return kind === "case" ? s.c.id : kind === "evidence" ? s.evidence.id : s.argument.id;
}

describe("applyRedaction: every field of every kind", () => {
  it.each(TARGETS)("removes a fragment from the %s %s and puts the placeholder in its place", async (kind, field) => {
    const admin = await makeAdmin();
    const s = await setup();
    const before = await read(kind, idOf(kind, s), field);
    const fragment = before.includes("MARK_a") ? "MARK_a" : "text";
    const result = f.unwrap(await redact(admin, { targetType: kind, targetId: idOf(kind, s), field, fragment }));
    expect(result.caseId).toBe(s.c.id);
    expect(await read(kind, idOf(kind, s), field)).toBe(before.split(fragment).join(P));
  });

  it.each(TARGETS)("blanks the whole %s %s", async (kind, field) => {
    const admin = await makeAdmin();
    const s = await setup();
    const before = await read(kind, idOf(kind, s), field);
    const result = f.unwrap(await redact(admin, { targetType: kind, targetId: idOf(kind, s), field, fragment: null }));
    expect(result.removed).toBe(before.length);
    expect(await read(kind, idOf(kind, s), field)).toBe(P);
  });
});

describe("applyRedaction: what it replaces", () => {
  it("replaces every occurrence and counts every character removed", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    const result = f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "summary", fragment: "MARK_a" }));
    expect(result).toEqual({ caseId: s.c.id, removed: 12 });
    expect(await read("case", s.c.id, "summary")).toBe(`Summary ${P} and ${P} again`);
  });

  it("turns the whole text into the placeholder when the fragment is the whole text", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "actual", fragment: "Actual text" }));
    expect(await read("case", s.c.id, "actual")).toBe(P);
  });

  it("changes only the field it was asked to change", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: "MARK_a" }));
    expect(await read("case", s.c.id, "summary")).toBe("Summary MARK_a and MARK_a again");
    expect(await read("evidence", s.evidence.id, "text")).toBe("trace MARK_a here");
    expect(await read("argument", s.argument.id, "reasoning")).toBe("Reasoning MARK_a here");
  });

  it("ignores any replacement text it is sent: only the fixed placeholder is ever stored", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: "MARK_a", replacement: "EVIL_TEXT", text: "EVIL_TEXT" }));
    expect(await read("case", s.c.id, "title")).toBe(`Title with ${P} inside`);
  });

  it("keeps the status of an argument and marks it redacted, and leaves a verdict standing", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    const issued = f.unwrap(await issueVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, winningArgumentId: s.argument.id }, NOW));
    f.unwrap(await redact(admin, { targetType: "argument", targetId: s.argument.id, field: "reasoning", fragment: "MARK_a" }, new Date(NOW.getTime() + 1000)));
    const [row] = await t.sql(`select status, redacted_at from arguments where id = $1`, [s.argument.id]);
    expect(row.status).toBe("won");
    expect(new Date(row.redacted_at as string).getTime()).toBe(NOW.getTime() + 1000);
    expect((await t.sql(`select status from verdicts where id = $1`, [issued.verdictId]))[0].status).toBe("active");
    expect((await t.sql(`select status from cases where id = $1`, [s.c.id]))[0].status).toBe("resolved");
  });

  it("can redact a held case, which stays held", async () => {
    const admin = await makeAdmin();
    const s = await setup("held");
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: "MARK_a" }));
    expect((await t.sql(`select status from cases where id = $1`, [s.c.id]))[0].status).toBe("held");
  });
});

describe("applyRedaction: the record it leaves", () => {
  it("writes one audit row and one moderation event, with the kind, the field and a count and never the removed text", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    const secret = "PLANTED_REMOVED_TEXT_99";
    await t.sql(`update cases set summary = $2 where id = $1`, [s.c.id, `before ${secret} after`]);
    const before = await counts();
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "summary", fragment: secret }));
    const after = await counts();
    expect(after.audit).toBe(before.audit + 1);
    expect(after.moderation).toBe(before.moderation + 1);
    expect(after.events).toBe(before.events);

    const audit = await t.sql(`select actor_type, actor_id, target, metadata from audit_log where action = 'redaction.applied' and target = $1`, [s.c.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "operator", actor_id: admin.id });
    expect(audit[0].metadata).toEqual({ targetType: "case", field: "summary", removed: secret.length });
    const events = await t.sql(`select target_type, target_id, "check", result, details from moderation_events where target_id = $1 and details ->> 'action' = 'redact'`, [s.c.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target_type: "case", check: "manual", result: "pass" });
    expect(events[0].details).toEqual({ action: "redact", field: "summary", removed: secret.length });
    expect(JSON.stringify([audit, events])).not.toContain(secret);
    expect(await read("case", s.c.id, "summary")).toBe(`before ${P} after`);
  });

  it("attributes an argument redaction to the argument and an evidence redaction to the evidence", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    f.unwrap(await redact(admin, { targetType: "argument", targetId: s.argument.id, field: "reasoning", fragment: "MARK_a" }));
    f.unwrap(await redact(admin, { targetType: "evidence", targetId: s.evidence.id, field: "text", fragment: "MARK_a" }));
    expect(await f.count(`moderation_events where target_type = 'argument' and target_id = $1 and details ->> 'action' = 'redact'`, [s.argument.id])).toBe(1);
    expect(await f.count(`moderation_events where target_type = 'evidence' and target_id = $1 and details ->> 'action' = 'redact'`, [s.evidence.id])).toBe(1);
  });
});

describe("applyRedaction: refusals write nothing", () => {
  it("refuses a fragment that is not in the field, and a field that is already blank", async () => {
    const admin = await makeAdmin();
    const s = await setup();
    const before = await counts();
    expect(f.errorOf(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: "not in there" }))).toBe("nothing_to_redact");
    f.unwrap(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: null }));
    const afterFirst = await counts();
    expect(f.errorOf(await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: null }))).toBe("nothing_to_redact");
    expect(await counts()).toEqual(afterFirst);
    expect(afterFirst.audit).toBe(before.audit + 1);
  });

  it("answers not_found for a target that does not exist, of each kind", async () => {
    const admin = await makeAdmin();
    for (const [kind, field] of [["case", "title"], ["evidence", "text"], ["argument", "reasoning"]] as const) {
      expect(f.errorOf(await redact(admin, { targetType: kind, targetId: UNKNOWN, field, fragment: null }))).toBe("not_found");
    }
  });

  it.each([
    ["an unknown kind", { targetType: "verdict", field: "title" }, ["targetType", "field"]],
    ["a bad id", { targetId: "nope" }, ["targetId"]],
    ["a field that does not belong to the kind", { targetType: "argument", field: "title" }, ["field"]],
    ["a case field on evidence", { targetType: "evidence", field: "summary" }, ["field"]],
    ["an evidence field on a case", { targetType: "case", field: "text" }, ["field"]],
    ["an empty fragment", { fragment: "" }, ["fragment"]],
    ["a fragment that is not text", { fragment: 12 }, ["fragment"]],
    ["a missing fragment: blanking must be asked for with null", { fragment: undefined }, ["fragment"]],
    ["a fragment over the size limit", { fragment: "x".repeat(32_001) }, ["fragment"]],
  ])("refuses %s and names the field", async (_name, over, fields) => {
    const admin = await makeAdmin();
    const s = await setup();
    const before = await counts();
    const result = await redact(admin, { targetType: "case", targetId: s.c.id, field: "title", fragment: "MARK_a", ...over });
    expect(f.errorOf(result)).toBe("invalid");
    expect(result.ok === false && Object.keys(result.detail ?? {}).sort()).toEqual([...fields].sort());
    expect(await counts()).toEqual(before);
    expect(await read("case", s.c.id, "title")).toBe("Title with MARK_a inside");
  });

  it("refuses anyone who is not an active admin, and reads the admin's status from the database", async () => {
    const s = await setup();
    const deleted = { ...(await makeAdmin()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    const stale = await makeAdmin();
    await t.sql("reset role");
    await t.sql(`update operators set status = 'suspended' where id = $1`, [stale.id]);
    await t.sql("set role app_server");
    const before = await counts();
    for (const who of [await makeAdmin("active", "operator"), await makeAdmin("pending"), await makeAdmin("suspended"), deleted, stale]) {
      expect(f.errorOf(await redact(who, { targetType: "case", targetId: s.c.id, field: "title", fragment: "MARK_a" }))).toBe("forbidden");
    }
    expect(await counts()).toEqual(before);
    expect(await read("case", s.c.id, "title")).toBe("Title with MARK_a inside");
  });

  it("checks the admin before the input", async () => {
    expect(f.errorOf(await redact(await makeAdmin("active", "operator"), {}))).toBe("forbidden");
  });

  it("never puts what was submitted into an error", async () => {
    const admin = await makeAdmin();
    const marker = "PLANTED_MARKER_321";
    const result = await redact(admin, { targetType: marker, targetId: marker, field: marker, fragment: 12 });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
