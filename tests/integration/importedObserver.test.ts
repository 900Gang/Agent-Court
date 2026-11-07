import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPORT } from "@/lib/config/constants";
import { ensureImporter } from "@/lib/import/identity";
import { parseManifestEntry } from "@/lib/import/manifest";
import { fixUrlFromNote } from "@/lib/import/sources";
import { importCase } from "@/lib/services/importService";
import { getPublicAgentView, getPublicCaseView, listHomeCases } from "@/lib/services/observerService";
import { createTestDb, type TestDb } from "../helpers/db";
import { createFixtures } from "../helpers/fixtures";
import { passGate } from "../helpers/gates";
import { entryFor } from "../helpers/importEntries";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
let importer: { operatorId: string; agentId: string };
const NOW = new Date("2026-03-01T10:00:00.000Z");

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
  importer = await ensureImporter(t.db);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function importOne(n: number) {
  const entry = f.unwrap(parseManifestEntry(entryFor(n)));
  const { caseId } = f.unwrap(await importCase(t.db, passGate, entry, NOW));
  return { entry, caseId };
}

describe("the public case view of an imported case", () => {
  it("carries the source, the link and the licence, and a verdict that is imported", async () => {
    const { entry, caseId } = await importOne(9001);
    const view = await getPublicCaseView(t.db, caseId);
    expect(view?.case).toMatchObject({ status: "resolved", source: "imported", sourceUrl: entry.issueUrl, sourceLicense: "MIT" });
    expect(view?.verdict).toMatchObject({ decidedBy: "imported", verificationLevel: "imported", status: "active" });
    expect(view?.filedBy.handle).toBe(IMPORT.handle);
    expect(view?.arguments).toHaveLength(1);
    expect(view?.arguments[0].argument.status).toBe("won");
  });

  it("keeps the link to the fix on the last line of the verdict note", async () => {
    const { entry, caseId } = await importOne(9002);
    const view = await getPublicCaseView(t.db, caseId);
    expect(fixUrlFromNote(view?.verdict?.note ?? null)).toBe(entry.fixUrl);
  });

  it("says nothing about the import operator", async () => {
    const { caseId } = await importOne(9003);
    const json = JSON.stringify(await getPublicCaseView(t.db, caseId));
    expect(json).not.toContain(importer.operatorId);
    expect(json).not.toContain(IMPORT.operatorGithubId);
    expect(json.toLowerCase()).not.toContain("githubid");
  });

  it("leaves a native case native, with no link and no licence", async () => {
    const { agent } = await f.makeAgent();
    const native = await f.insertCase(agent.id, { status: "open" });
    const view = await getPublicCaseView(t.db, native.id);
    expect(view?.case).toMatchObject({ source: "native", sourceUrl: null, sourceLicense: null });
  });
});

describe("the public profile of the import account", () => {
  it("has no reputation, lists its imported cases, and holds no operator data", async () => {
    const { caseId } = await importOne(9004);
    const view = await getPublicAgentView(t.db, IMPORT.handle);
    expect(view?.reputation).toEqual({ points: 0, tier: 0 });
    expect(view?.cases.map((entry) => entry.case.id)).toContain(caseId);
    expect(view?.cases.every((entry) => entry.case.source === "imported")).toBe(true);
    expect(view?.counts.publicCases).toBeGreaterThan(0);
    const json = JSON.stringify(view);
    expect(json).not.toContain(importer.operatorId);
    expect(json).not.toContain(IMPORT.operatorGithubId);
  });
});

describe("the home lists", () => {
  it("show an imported case among the recently resolved, labelled by its source", async () => {
    const { caseId } = await importOne(9005);
    const home = await listHomeCases(t.db);
    const found = home.resolved.find((entry) => entry.case.id === caseId);
    expect(found?.case.source).toBe("imported");
  });
});
