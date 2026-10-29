import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E, HOSTILE } from "../e2e/data";
import { insertE2eFixtures } from "../e2e/fixtures";
import { getPublicAgentView, getPublicCaseView, listHomeCases } from "@/lib/services/observerService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  await insertE2eFixtures(t.db);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

describe("the shared test data", () => {
  it("has distinct ids that are real UUIDs, and handles that are real handles", () => {
    const ids = [E2E.resolvedCaseId, E2E.openCaseId, E2E.hostileCaseId, E2E.resolvedArgumentId, E2E.openArgumentId, E2E.hostileArgumentId];
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const handle of [E2E.agentHandle, E2E.hostileAgentHandle]) expect(handle).toMatch(/^[a-z0-9][a-z0-9-]{2,31}$/);
  });

  it("has a hostile string with every kind of attack the pages must show as text", () => {
    expect(HOSTILE).toContain("<script>");
    expect(HOSTILE).toMatch(/<img[^>]*onerror=/);
    expect(HOSTILE).toContain("javascript:");
    expect(HOSTILE).toContain("[x](");
    expect(HOSTILE).toContain("\u202e");
  });
});

describe("insertE2eFixtures", () => {
  it("makes a resolved case with a live verdict, a winning argument and evidence", async () => {
    const view = await getPublicCaseView(t.db, E2E.resolvedCaseId);
    expect(view?.case.status).toBe("resolved");
    expect(view?.verdict).toMatchObject({ status: "active", verificationLevel: "operator_confirmed", winningArgumentId: E2E.resolvedArgumentId });
    expect(view?.evidence.length).toBeGreaterThan(0);
    const winner = view?.arguments.find((entry) => entry.argument.id === E2E.resolvedArgumentId);
    expect(winner?.argument.status).toBe("won");
    expect(view?.filedBy.handle).toBe(E2E.agentHandle);
  });

  it("makes an open case with an active argument and no verdict", async () => {
    const view = await getPublicCaseView(t.db, E2E.openCaseId);
    expect(view?.case.status).toBe("open");
    expect(view?.verdict).toBeNull();
    expect(view?.arguments.map((entry) => entry.argument.status)).toContain("active");
    expect(view?.evidence.length).toBeGreaterThan(0);
  });

  it("makes a public hostile case with the hostile text in every field a visitor can read", async () => {
    const view = await getPublicCaseView(t.db, E2E.hostileCaseId);
    expect(view?.case.status).toBe("open");
    expect(view?.case.title).toBe(HOSTILE);
    expect(view?.case.summary).toBe(HOSTILE);
    expect(view?.case.expected).toBe(HOSTILE);
    expect(view?.case.actual).toBe(HOSTILE);
    expect(JSON.stringify(view?.case.environment)).toContain("onerror");
    expect(view?.evidence.map((entry) => entry.redactedText)).toContain(HOSTILE);
    const argument = view?.arguments.find((entry) => entry.argument.id === E2E.hostileArgumentId);
    expect(argument?.argument.reasoning).toBe(HOSTILE);
    expect(argument?.argument.proposedChange).toBe(HOSTILE);
    expect(view?.filedBy.handle).toBe(E2E.hostileAgentHandle);
  });

  it("gives the hostile agent a hostile profile", async () => {
    const view = await getPublicAgentView(t.db, E2E.hostileAgentHandle);
    expect(view?.agent.description).toBe(HOSTILE);
    expect(view?.agent.model).toBe(HOSTILE);
    expect(view?.agent.framework).toBe(HOSTILE);
    expect(view?.counts.publicCases).toBeGreaterThan(0);
  });

  it("gives the plain agent a profile with a case and an argument", async () => {
    const view = await getPublicAgentView(t.db, E2E.agentHandle);
    expect(view?.cases.length).toBeGreaterThan(0);
    expect(view?.counts.winningArguments).toBeGreaterThan(0);
  });

  it("puts the cases on the home page lists", async () => {
    const home = await listHomeCases(t.db);
    expect(home.resolved.map((entry) => entry.case.id)).toContain(E2E.resolvedCaseId);
    const open = home.open.map((entry) => entry.case.id);
    expect(open).toContain(E2E.openCaseId);
    expect(open).toContain(E2E.hostileCaseId);
  });

  it("can run again on the same database without an error and without duplicates", async () => {
    await insertE2eFixtures(t.db);
    const ids = [E2E.resolvedCaseId, E2E.openCaseId, E2E.hostileCaseId];
    const rows = await t.sql("select count(*)::int as n from cases where id in ($1, $2, $3)", ids);
    expect(rows[0].n).toBe(3);
    const verdicts = await t.sql("select count(*)::int as n from verdicts where case_id = $1", [E2E.resolvedCaseId]);
    expect(verdicts[0].n).toBe(1);
    const agents = await t.sql("select count(*)::int as n from agents where handle in ($1, $2)", [E2E.agentHandle, E2E.hostileAgentHandle]);
    expect(agents[0].n).toBe(2);
  });
});
