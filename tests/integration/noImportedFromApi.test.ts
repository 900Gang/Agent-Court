import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { moderateCore } from "@/lib/admin/actionsCore";
import { registerAgentCore, type ActionDeps } from "@/lib/dashboard/actionsCore";
import { issueVerdictCore } from "@/lib/dashboard/verdictCore";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase } from "@/lib/http/handlers/cases";
import { handleSubmitArgument } from "@/lib/http/handlers/arguments";
import { parseManifestEntry } from "@/lib/import/manifest";
import { ensureImporter } from "@/lib/import/identity";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { importCase } from "@/lib/services/importService";
import { issueKey } from "@/lib/services/keyService";
import { createTestDb, type TestDb } from "../helpers/db";
import { createFixtures } from "../helpers/fixtures";
import { passGate } from "../helpers/gates";
import { entryFor } from "../helpers/importEntries";

// AC-901 and the design's "only the import path": whatever an agent, an operator or an administrator sends, no case
// is stored as imported, no verdict as imported, and no import audit row appears. The one control is the import itself.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = "http://localhost:3000";
const URL = "https://github.com/langchain-ai/langchain/issues/4242";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function importedCounts(): Promise<{ cases: number; withLink: number; verdicts: number; levels: number; audit: number }> {
  return {
    cases: await f.count("cases where source = 'imported'"),
    withLink: await f.count("cases where source_url is not null or source_license is not null"),
    verdicts: await f.count("verdicts where decided_by = 'imported'"),
    levels: await f.count("verdicts where verification_level = 'imported'"),
    audit: await f.count("audit_log where action = 'case.imported'"),
  };
}

const NONE = { cases: 0, withLink: 0, verdicts: 0, levels: 0, audit: 0 };

const apiDeps = (): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(), gate: passGate, writesEnabled: true });

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

function req(method: string, path: string, key: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const dashDeps = (operator: Operator | null): ActionDeps => ({ db: t.db, operator, headers: new Headers({ origin: ORIGIN }), expectedOrigin: ORIGIN });

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  return data;
}

const FILING = { title: "T", summary: "S", expected: "E", actual: "A", tags: [], environment: {}, evidence: [] };
const IMPORTED_FIELDS = {
  source: "imported",
  source_url: URL,
  source_license: "MIT",
  sourceUrl: URL,
  sourceLicense: "MIT",
  status: "resolved",
  decided_by: "imported",
  verification_level: "imported",
};

describe("agent requests through the API", () => {
  it("refuses a case that asks to be imported, and stores nothing", async () => {
    const author = await agentWithKey();
    const before = await f.count("cases");
    const response = await handleFileCase(req("POST", "/api/v1/cases", author.key, { ...FILING, ...IMPORTED_FIELDS }), apiDeps());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await f.count("cases")).toBe(before);
    expect(await importedCounts()).toEqual(NONE);
  });

  it.each(Object.entries(IMPORTED_FIELDS))("refuses a case with only %s set", async (key, value) => {
    const author = await agentWithKey();
    const response = await handleFileCase(req("POST", "/api/v1/cases", author.key, { ...FILING, [key]: value }), apiDeps());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await importedCounts()).toEqual(NONE);
  });

  it("stores an ordinary case as native, with no link and no licence", async () => {
    const author = await agentWithKey();
    const response = await handleFileCase(req("POST", "/api/v1/cases", author.key, FILING), apiDeps());
    expect(response.status).toBe(201);
    const id = ((await response.json()) as Json).case.id as string;
    const [row] = await t.sql(`select source, source_url, source_license from cases where id = $1`, [id]);
    expect(row).toEqual({ source: "native", source_url: null, source_license: null });
  });

  it("ignores nothing it does not understand when an argument asks to be imported", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const author = await agentWithKey();
    const response = await handleSubmitArgument(
      req("POST", `/api/v1/cases/${c.id}/arguments`, author.key, { reasoning: "r", proposed_change: "p", ...IMPORTED_FIELDS }),
      apiDeps(),
      { id: c.id },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await importedCounts()).toEqual(NONE);
  });
});

describe("operator forms", () => {
  it("registering an agent with extra import fields makes an ordinary agent and no imported case", async () => {
    const operator = await f.makeOperator();
    const result = await registerAgentCore(dashDeps(operator), form({ handle: f.uniq("agent"), source: "imported", sourceUrl: URL, decidedBy: "imported" }));
    expect(result.ok).toBe(true);
    expect(await importedCounts()).toEqual(NONE);
  });

  it("issuing a verdict with import fields in the form gives an operator verdict, never an imported one", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const rival = await f.makeAgent();
    const argument = await f.insertArgument(c.id, rival.actor.agentId, "active");
    const result = await issueVerdictCore(
      dashDeps(filer.operator),
      form({
        caseId: c.id,
        winningArgumentId: argument.id,
        decidedBy: "imported",
        decided_by: "imported",
        verificationLevel: "imported",
        verification_level: "imported",
        source: "imported",
        sourceUrl: URL,
      }),
    );
    expect(result.ok).toBe(true);
    const [verdict] = await t.sql(`select decided_by, verification_level from verdicts where case_id = $1`, [c.id]);
    expect(verdict).toEqual({ decided_by: "operator", verification_level: "operator_confirmed" });
    const [row] = await t.sql(`select source, source_url from cases where id = $1`, [c.id]);
    expect(row).toEqual({ source: "native", source_url: null });
    expect(await importedCounts()).toEqual(NONE);
  });
});

describe("administrator actions", () => {
  it("approving and rejecting held cases leaves them native", async () => {
    const [admin] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role: "admin", status: "active" }).returning();
    const owner = await f.makeAgent();
    const approved = await f.insertCase(owner.actor.agentId, { status: "held" });
    const rejected = await f.insertCase(owner.actor.agentId, { status: "held" });
    expect((await moderateCore(dashDeps(admin), { kind: "case", id: approved.id, decision: "approve" })).ok).toBe(true);
    expect((await moderateCore(dashDeps(admin), { kind: "case", id: rejected.id, decision: "reject" })).ok).toBe(true);
    for (const id of [approved.id, rejected.id]) {
      const [row] = await t.sql(`select source, source_url, source_license from cases where id = $1`, [id]);
      expect(row).toEqual({ source: "native", source_url: null, source_license: null });
    }
    expect(await importedCounts()).toEqual(NONE);
  });
});

describe("the control: the import is the one thing that does make an imported case", () => {
  it("adds exactly one imported case, one imported verdict and one import audit row", async () => {
    await ensureImporter(t.db);
    const before = await importedCounts();
    expect(before).toEqual({ ...NONE, withLink: before.withLink });
    const entry = f.unwrap(parseManifestEntry(entryFor(4242)));
    f.unwrap(await importCase(t.db, passGate, entry, new Date("2026-03-01T10:00:00.000Z")));
    const after = await importedCounts();
    expect(after).toEqual({ cases: 1, withLink: before.withLink + 1, verdicts: 1, levels: 1, audit: 1 });
  });
});
