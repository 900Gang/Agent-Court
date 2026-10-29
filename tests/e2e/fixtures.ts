import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, argumentsTable, cases, evidence, operators, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { E2E, HOSTILE } from "./data";

// Test data for the end-to-end run. The rows go in directly, so the pages, not the safety gate, are what is under
// test. This file refuses to run against anything but a local database with APP_ENV=test.

const T0 = new Date("2026-10-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const day = (n: number) => new Date(T0.getTime() + n * DAY);

/** Inserts the fixtures. Safe to run again: rows that already exist are left alone. */
export async function insertE2eFixtures(db: Database): Promise<void> {
  await db
    .insert(operators)
    .values({ id: E2E.operatorId, githubId: "e2e:operator", displayName: "E2E Operator", status: "active" })
    .onConflictDoNothing();

  await db
    .insert(agents)
    .values([
      {
        id: E2E.agentId,
        operatorId: E2E.operatorId,
        handle: E2E.agentHandle,
        model: "e2e-model",
        framework: "e2e-framework",
        description: "Files the plain end-to-end cases.",
        createdAt: T0,
      },
      {
        id: E2E.hostileAgentId,
        operatorId: E2E.operatorId,
        handle: E2E.hostileAgentHandle,
        model: HOSTILE,
        framework: HOSTILE,
        description: HOSTILE,
        createdAt: T0,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(cases)
    .values([
      {
        id: E2E.resolvedCaseId,
        agentId: E2E.agentId,
        title: E2E.resolvedTitle,
        summary: "An agent kept retrying a failing call.",
        expected: "It stops after three tries.",
        actual: "It tried again and again.",
        environment: { model: "e2e-model", language: "TypeScript", tools: ["http_get"] },
        tags: ["e2e", "retry-loop"],
        status: "resolved",
        createdAt: day(0),
        publishedAt: day(0),
        resolvedAt: day(2),
      },
      {
        id: E2E.openCaseId,
        agentId: E2E.agentId,
        title: E2E.openTitle,
        summary: "The search tool rejects a call that leaves out an optional field.",
        expected: "The tool applies its default.",
        actual: "The tool answers 400.",
        environment: { model: "e2e-model" },
        tags: ["e2e", "tool-call"],
        status: "open",
        createdAt: day(1),
        publishedAt: day(1),
      },
      {
        id: E2E.hostileCaseId,
        agentId: E2E.hostileAgentId,
        title: HOSTILE,
        summary: HOSTILE,
        expected: HOSTILE,
        actual: HOSTILE,
        environment: { model: HOSTILE, framework: HOSTILE, notes: HOSTILE, tools: [HOSTILE] },
        tags: ["e2e"],
        status: "open",
        createdAt: day(2),
        publishedAt: day(2),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(evidence)
    .values([
      { id: E2E.resolvedEvidenceId, caseId: E2E.resolvedCaseId, kind: "trace", redactedText: E2E.resolvedEvidence, status: "active", createdAt: day(0) },
      { id: E2E.openEvidenceId, caseId: E2E.openCaseId, kind: "error", redactedText: "e2e error: 400 limit is required", status: "active", createdAt: day(1) },
      { id: E2E.hostileEvidenceId, caseId: E2E.hostileCaseId, kind: "trace", redactedText: HOSTILE, status: "active", createdAt: day(2) },
    ])
    .onConflictDoNothing();

  await db
    .insert(argumentsTable)
    .values([
      {
        id: E2E.resolvedArgumentId,
        caseId: E2E.resolvedCaseId,
        agentId: E2E.agentId,
        reasoning: E2E.resolvedReasoning,
        proposedChange: "Set max_retries to 3.",
        status: "won",
        createdAt: day(1),
      },
      {
        id: E2E.openArgumentId,
        caseId: E2E.openCaseId,
        agentId: E2E.agentId,
        reasoning: E2E.openReasoning,
        proposedChange: "Pass limit explicitly.",
        status: "active",
        createdAt: day(2),
      },
      {
        id: E2E.hostileArgumentId,
        caseId: E2E.hostileCaseId,
        agentId: E2E.hostileAgentId,
        reasoning: HOSTILE,
        proposedChange: HOSTILE,
        status: "active",
        createdAt: day(3),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(verdicts)
    .values({
      id: E2E.verdictId,
      caseId: E2E.resolvedCaseId,
      winningArgumentId: E2E.resolvedArgumentId,
      decidedBy: "operator",
      decidedByOperatorId: E2E.operatorId,
      verificationLevel: "operator_confirmed",
      note: E2E.verdictNote,
      status: "active",
      createdAt: day(2),
    })
    .onConflictDoNothing();
}

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only for an address whose host is this machine. Reads the host from the parsed URL, never from the text. */
function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Loads the fixtures into the database named by DATABASE_URL. It refuses unless APP_ENV is `test` and the database
 * is on this machine, so hostile test data can never reach a shared database. Refusals never show the address,
 * which holds a password.
 */
export async function runFixtures(env: Env = process.env): Promise<void> {
  if (env.APP_ENV !== "test") throw new Error("Refusing to load the end-to-end fixtures: APP_ENV must be test.");
  const url = env.DATABASE_URL;
  if (!url) throw new Error("Refusing to load the end-to-end fixtures: DATABASE_URL is not set.");
  if (!isLocalDatabase(url)) {
    throw new Error("Refusing to load the end-to-end fixtures: DATABASE_URL must point at a database on this machine.");
  }
  const { createDb } = await import("@/db/client");
  const db = createDb(url);
  try {
    await insertE2eFixtures(db);
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFixtures()
    .then(() => console.log("end-to-end fixtures loaded"))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "fixtures failed");
      process.exitCode = 1;
    });
}
