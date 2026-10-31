import { and, count, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { operators, reputationEvents, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { awardPoints, capReason, releaseAt as releaseAtFor, tierFor } from "@/lib/reputation/rules";

// The only file that reads or writes reputation_events. `pnpm check:routes` fails CI if any other file mentions the
// table, so no route, tool or service can add points. Points come from a verdict and nowhere else (threat T5).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Reputation = { points: number; pending: number; tier: 0 | 1 | 2 | 3 };

/**
 * Records what a verdict is worth to the winning agent: a pending event, released when the appeal window ends. The
 * pairwise cap is applied here: the same issuing operator awarding the same receiving operator pays 10, 10, 10, 5, 2,
 * then 0, counting every earlier award between them that was not reversed (a zero-point award still counts). The
 * issuing operator's row is locked first, so two verdicts by one operator on different cases cannot both read the same
 * count. A verdict can pay once: a second event for it is refused by a unique index.
 */
export async function awardForVerdict(
  db: Database,
  input: { verdictId: string; agentId: string; receivingOperatorId: string; issuingOperatorId: string; at: Date },
): Promise<{ points: number; releaseAt: Date }> {
  await db.select({ id: operators.id }).from(operators).where(eq(operators.id, input.issuingOperatorId)).limit(1).for("update");
  const [{ n }] = await db
    .select({ n: count() })
    .from(reputationEvents)
    .innerJoin(verdicts, eq(verdicts.id, reputationEvents.verdictId))
    .where(
      and(
        eq(reputationEvents.operatorId, input.receivingOperatorId),
        eq(verdicts.decidedByOperatorId, input.issuingOperatorId),
        ne(reputationEvents.status, "reversed"),
      ),
    );
  const points = awardPoints(n);
  const release = releaseAtFor(input.at);
  await db.insert(reputationEvents).values({
    agentId: input.agentId,
    operatorId: input.receivingOperatorId,
    verdictId: input.verdictId,
    points,
    reason: capReason(n),
    status: "pending",
    releaseAt: release,
  });
  return { points, releaseAt: release };
}

/**
 * Pending events whose release time has passed become final, unless their verdict is under appeal or overturned: those
 * wait. Idempotent. Returns how many were released.
 */
export async function releaseDue(db: Database, now: Date): Promise<number> {
  const released = await db
    .update(reputationEvents)
    .set({ status: "final" })
    .where(
      and(
        eq(reputationEvents.status, "pending"),
        isNotNull(reputationEvents.releaseAt),
        lte(reputationEvents.releaseAt, now),
        inArray(reputationEvents.verdictId, db.select({ id: verdicts.id }).from(verdicts).where(eq(verdicts.status, "active"))),
      ),
    )
    .returning({ id: reputationEvents.id });
  return released.length;
}

/** An overturned verdict takes its points back. Pending and final events become reversed. True when something changed. */
export async function reverseForVerdict(db: Database, verdictId: string): Promise<boolean> {
  if (!UUID.test(verdictId)) return false;
  const changed = await db
    .update(reputationEvents)
    .set({ status: "reversed" })
    .where(and(eq(reputationEvents.verdictId, verdictId), inArray(reputationEvents.status, ["pending", "final"])))
    .returning({ id: reputationEvents.id });
  return changed.length > 0;
}

/** Final points, pending points and the tier. Only final points count toward the tier. */
export async function getReputation(db: Database, agentId: string): Promise<Reputation> {
  if (!UUID.test(agentId)) return { points: 0, pending: 0, tier: 0 };
  const [row] = await db
    .select({
      points: sql<number>`coalesce(sum(${reputationEvents.points}) filter (where ${reputationEvents.status} = 'final'), 0)::int`,
      pending: sql<number>`coalesce(sum(${reputationEvents.points}) filter (where ${reputationEvents.status} = 'pending'), 0)::int`,
    })
    .from(reputationEvents)
    .where(eq(reputationEvents.agentId, agentId));
  return { points: row.points, pending: row.pending, tier: tierFor(row.points) };
}

/** The tier alone, in one statement: it runs on every API request. A malformed id costs no query. */
export async function tierOf(db: Database, agentId: string): Promise<0 | 1 | 2 | 3> {
  if (!UUID.test(agentId)) return 0;
  const [row] = await db
    .select({ points: sql<number>`coalesce(sum(${reputationEvents.points}), 0)::int` })
    .from(reputationEvents)
    .where(and(eq(reputationEvents.agentId, agentId), eq(reputationEvents.status, "final")));
  return tierFor(row.points);
}
