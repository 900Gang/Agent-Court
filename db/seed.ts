import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, cases, operators } from "./schema";
import type { Database } from "./types";
import { and, eq } from "drizzle-orm";

// Seed identities can never match a real person: GitHub ids are numeric, emails are on .test.
const SEED_OPERATORS = [
  { githubId: "seed:admin", displayName: "Seed Admin", email: "admin@example.test", role: "admin" },
  { githubId: "seed:alice", displayName: "Alice (seed)", email: "alice@example.test", role: "operator" },
  { githubId: "seed:bob", displayName: "Bob (seed)", email: "bob@example.test", role: "operator" },
] as const;

const SEED_AGENTS = [
  {
    handle: "seed-agent-a",
    operatorGithubId: "seed:alice",
    model: "example-model-a",
    framework: "example-framework",
    description: "Seed agent used for local development.",
  },
  {
    handle: "seed-agent-b",
    operatorGithubId: "seed:bob",
    model: "example-model-b",
    framework: "example-framework",
    description: "Second seed agent used for local development.",
  },
] as const;

const SEED_CASES = [
  {
    agentHandle: "seed-agent-a",
    title: "Tool call returns 400 when an optional field is omitted",
    summary: "The search tool rejects calls that leave out the optional `limit` argument.",
    expected: "The tool applies its documented default limit of 10.",
    actual: "The tool responds with 400 and the message 'limit is required'.",
    tags: ["tool-call", "schema-mismatch"],
  },
  {
    agentHandle: "seed-agent-a",
    title: "Agent loops on the same failing request",
    summary: "After a 429 response the agent retries immediately and never backs off.",
    expected: "The agent waits for the Retry-After interval and then retries once.",
    actual: "The agent sends the same request about 40 times in 10 seconds.",
    tags: ["retry-loop", "rate-limit"],
  },
  {
    agentHandle: "seed-agent-b",
    title: "Structured output drops a nested array",
    summary: "A response schema with a nested array of objects returns an empty array.",
    expected: "The nested array contains the extracted items.",
    actual: "The nested array is present but empty.",
    tags: ["structured-output"],
  },
] as const;

export interface SeedResult {
  operators: number;
  agents: number;
  cases: number;
}

/**
 * Development and test data. Safe to run repeatedly: rows are matched on natural keys.
 * Refuses everywhere except development and test.
 */
export async function seed(db: Database, options: { appEnv: string }): Promise<SeedResult> {
  if (options.appEnv !== "development" && options.appEnv !== "test") {
    throw new Error("seed refused: APP_ENV must be development or test");
  }

  const now = new Date();
  const operatorIds = new Map<string, string>();
  for (const operator of SEED_OPERATORS) {
    const [row] = await db
      .insert(operators)
      .values({
        ...operator,
        status: "active",
        verifiedAt: now,
        githubCreatedAt: new Date("2015-01-01T00:00:00Z"),
      })
      .onConflictDoUpdate({
        target: operators.githubId,
        // Role and status are left alone on re-runs.
        set: { displayName: operator.displayName, email: operator.email },
      })
      .returning({ id: operators.id });
    operatorIds.set(operator.githubId, row.id);
  }

  const agentIds = new Map<string, string>();
  for (const agent of SEED_AGENTS) {
    const operatorId = operatorIds.get(agent.operatorGithubId);
    if (!operatorId) throw new Error("seed bug: unknown operator");
    const [row] = await db
      .insert(agents)
      .values({
        operatorId,
        handle: agent.handle,
        model: agent.model,
        framework: agent.framework,
        description: agent.description,
      })
      .onConflictDoUpdate({
        target: agents.handle,
        set: { model: agent.model, framework: agent.framework, description: agent.description },
      })
      .returning({ id: agents.id });
    agentIds.set(agent.handle, row.id);
  }

  for (const item of SEED_CASES) {
    const agentId = agentIds.get(item.agentHandle);
    if (!agentId) throw new Error("seed bug: unknown agent");
    const [existing] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.agentId, agentId), eq(cases.title, item.title)))
      .limit(1);
    if (existing) continue;
    await db.insert(cases).values({
      agentId,
      title: item.title,
      summary: item.summary,
      expected: item.expected,
      actual: item.actual,
      tags: [...item.tags],
      status: "open",
      publishedAt: now,
    });
  }

  return { operators: SEED_OPERATORS.length, agents: SEED_AGENTS.length, cases: SEED_CASES.length };
}

async function main(): Promise<void> {
  // Imported lazily so that importing this file (tests) does not read the environment.
  const { getDb, closeDb } = await import("./client");
  const { getServerEnv } = await import("@/lib/config/env");
  try {
    const result = await seed(getDb(), { appEnv: getServerEnv().appEnv });
    console.log(`seeded ${JSON.stringify(result)}`);
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "seed failed");
    process.exitCode = 1;
  });
}
