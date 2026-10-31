import { readFileSync } from "node:fs";
import path from "node:path";
import { agents, cases, operators } from "@/db/schema";
import type { Database } from "@/db/types";

// The duplicate-recall fixture (AC-708): 50 originals (c01 to c50), 50 unrelated distractors (d01 to d50) and 50 queries,
// each a rewording of one original. Test-only: nothing under app/, lib/ or components/ may import this file.

export type DuplicateCase = { id: string; title: string; summary: string; expected: string; actual: string; tags: string[] };
export type DuplicateQuery = { id: string; text: string; truth: string };

export function loadDuplicates(): { cases: DuplicateCase[]; queries: DuplicateQuery[] } {
  const raw = readFileSync(path.resolve(process.cwd(), "tests/fixtures/duplicates-100.json"), "utf8");
  return JSON.parse(raw) as { cases: DuplicateCase[]; queries: DuplicateQuery[] };
}

/** A fixed UUID per fixture id, so search results can be turned back into the ids the fixture uses. */
export function uuidFor(fixtureId: string): string {
  const kind = fixtureId.startsWith("c") ? "1" : "2";
  return `00000000-0000-4d0${kind}-8000-${String(Number(fixtureId.slice(1))).padStart(12, "0")}`;
}

export function fixtureIdOf(uuid: string): string {
  const match = /^00000000-0000-4d0([12])-8000-(\d{12})$/.exec(uuid);
  if (!match) throw new Error("not a fixture id");
  return `${match[1] === "1" ? "c" : "d"}${String(Number(match[2])).padStart(2, "0")}`;
}

/** Inserts one operator, one agent and the 100 cases as public cases, oldest first. */
export async function insertDuplicatesCorpus(db: Database, status: "resolved" | "open" = "resolved"): Promise<void> {
  const fixture = loadDuplicates();
  const [operator] = await db.insert(operators).values({ githubId: "dup:operator", displayName: "Fixture Operator", status: "active" }).returning();
  const [agent] = await db.insert(agents).values({ operatorId: operator.id, handle: "dup-agent" }).returning();
  const start = Date.UTC(2026, 0, 1);
  await db.insert(cases).values(
    fixture.cases.map((c, index) => ({
      id: uuidFor(c.id),
      agentId: agent.id,
      title: c.title,
      summary: c.summary,
      expected: c.expected,
      actual: c.actual,
      tags: c.tags,
      status,
      createdAt: new Date(start + index * 1000),
      publishedAt: new Date(start + index * 1000),
    })),
  );
}
