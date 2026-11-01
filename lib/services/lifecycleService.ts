import { and, asc, count, eq, inArray, isNotNull, lte, ne, notExists, sql } from "drizzle-orm";
import { cases, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { LIFECYCLE } from "@/lib/config/constants";
import { writeAudit } from "./auditService";
import { nextState } from "./stateMachine";

const DAY_MS = 86_400_000;

/**
 * Cases that are open or argued, were published at least `autoCloseDays` ago, and have no verdict. A verdict, even one
 * on a case left open by mistake, always keeps a case from closing.
 */
function eligible(db: Database, cutoff: Date) {
  return and(
    inArray(cases.status, ["open", "argued"]),
    isNotNull(cases.publishedAt),
    lte(cases.publishedAt, cutoff),
    notExists(db.select({ one: sql`1` }).from(verdicts).where(and(eq(verdicts.caseId, cases.id), ne(verdicts.status, "overturned")))),
  );
}

/**
 * Closes idle cases: still open or argued 14 days after publication. Oldest first, at most `limit` per run. Each case is
 * closed in its own transaction that locks the row and checks again, so a verdict, a withdrawal or an overlapping run that
 * got there first simply makes this one skip the case. The move goes through the state machine, and the audit row names
 * the system and the case, nothing else. Safe to run again at any time. `remaining` counts what a later run will take.
 */
export async function closeIdleCases(db: Database, now: Date, options: { limit: number }): Promise<{ closed: number; remaining: number }> {
  const cutoff = new Date(now.getTime() - LIFECYCLE.autoCloseDays * DAY_MS);
  const limit = Number.isFinite(options.limit) ? Math.floor(options.limit) : 0;

  let closed = 0;
  if (limit > 0) {
    const candidates = await db.select({ id: cases.id }).from(cases).where(eligible(db, cutoff)).orderBy(asc(cases.publishedAt), asc(cases.id)).limit(limit);
    for (const { id } of candidates) {
      const done = await db.transaction(async (tx): Promise<boolean> => {
        const [c] = await tx.select().from(cases).where(eq(cases.id, id)).limit(1).for("update");
        if (!c || c.publishedAt === null || c.publishedAt.getTime() > cutoff.getTime()) return false;
        if (nextState(c.status, "timeout") !== "closed_unresolved") return false;
        const [verdict] = await tx.select({ id: verdicts.id }).from(verdicts).where(and(eq(verdicts.caseId, c.id), ne(verdicts.status, "overturned"))).limit(1);
        if (verdict) return false;
        await tx.update(cases).set({ status: "closed_unresolved" }).where(eq(cases.id, c.id));
        await writeAudit(tx, { actorType: "system", actorId: null, action: "case.closed", target: c.id });
        return true;
      });
      if (done) closed += 1;
    }
  }

  const [{ n }] = await db.select({ n: count() }).from(cases).where(eligible(db, cutoff));
  return { closed, remaining: n };
}
