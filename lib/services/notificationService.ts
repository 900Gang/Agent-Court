import { and, asc, eq, exists, gt, gte, inArray, isNotNull, lte, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agents, argumentsTable, auditLog, cases, notificationLog, operators, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { LIFECYCLE } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { EmailError, type EmailProvider } from "@/lib/email/provider";
import { noticeMessage, type Notice } from "@/lib/email/notices";
import { reminderStage } from "@/lib/lifecycle/rules";

const DAY_MS = 86_400_000;

export type NoticeSummary = { sent: number; failed: number; skippedNoAddress: number; alreadySent: number };

const recipient = {
  operatorId: operators.id,
  email: operators.email,
  operatorStatus: operators.status,
  operatorDeletedAt: operators.deletedAt,
};
type Recipient = { operatorId: string; email: string | null; operatorStatus: string; operatorDeletedAt: Date | null };

const iso = (date: Date) => date.toISOString();

/**
 * Sends what is due, by email, to the operators who filed the cases. Four kinds, each found by one bounded query that
 * already leaves out what was sent: a reminder on day 3, 7 or 12 (the highest day reached) for an argued case with an
 * active argument; a new argument made in the last few days by an agent of another operator; the outcome of an appeal
 * decided in the last few days; a case closed in the last few days. Each notice is claimed in notification_log before
 * it is sent, so overlapping runs send once; a send that fails gives its claim back, so the next run tries again. An
 * operator who cannot be mailed (no address, not active, deleted) is skipped and nothing is claimed. A message holds
 * ids, numbers and fixed words only. Returns counts and never fails because a mail provider does.
 */
export async function sendDueNotices(
  db: Database,
  provider: EmailProvider,
  now: Date,
  options: { baseUrl: string; limit: number },
): Promise<NoticeSummary> {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0;
  const summary: NoticeSummary = { sent: 0, failed: 0, skippedNoAddress: 0, alreadySent: 0 };
  if (limit === 0) return summary;

  const windowStart = new Date(now.getTime() - LIFECYCLE.noticeWindowDays * DAY_MS);

  async function deliver(to: Recipient, kind: string, targetId: string, notice: Notice): Promise<void> {
    if (to.email === null || to.operatorStatus !== "active" || to.operatorDeletedAt !== null) {
      summary.skippedNoAddress += 1;
      return;
    }
    const [claim] = await db.insert(notificationLog).values({ kind, targetId, operatorId: to.operatorId }).onConflictDoNothing().returning({ id: notificationLog.id });
    if (!claim) {
      summary.alreadySent += 1;
      return;
    }
    try {
      const message = noticeMessage(notice, options.baseUrl);
      await provider.send({ to: to.email, ...message });
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn("email notice failed", { kind, code: error instanceof EmailError ? error.code : "unexpected" });
      try {
        await db.delete(notificationLog).where(eq(notificationLog.id, claim.id));
      } catch {
        // The claim stays; the notice is not sent again. Better than sending it twice.
      }
    }
  }

  // 1. Reminders: argued cases at day 3 or later (and before they close), with an active argument.
  const d3 = new Date(now.getTime() - 3 * DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d12 = new Date(now.getTime() - 12 * DAY_MS);
  const d14 = new Date(now.getTime() - LIFECYCLE.autoCloseDays * DAY_MS);
  const stageSql = sql`case when ${cases.publishedAt} <= ${iso(d12)}::timestamptz then 12 when ${cases.publishedAt} <= ${iso(d7)}::timestamptz then 7 else 3 end`;
  const reminders = await db
    .select({
      caseId: cases.id,
      publishedAt: cases.publishedAt,
      waiting: sql<number>`(select count(*)::int from ${argumentsTable} where ${argumentsTable.caseId} = "cases"."id" and ${argumentsTable.status} = 'active')`,
      ...recipient,
    })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(
      and(
        eq(cases.status, "argued"),
        isNotNull(cases.publishedAt),
        lte(cases.publishedAt, d3),
        gt(cases.publishedAt, d14),
        exists(db.select({ one: sql`1` }).from(argumentsTable).where(and(eq(argumentsTable.caseId, cases.id), eq(argumentsTable.status, "active")))),
        notExists(
          db
            .select({ one: sql`1` })
            .from(notificationLog)
            .where(and(sql`${notificationLog.kind} = 'reminder_' || (${stageSql})`, eq(notificationLog.targetId, cases.id), eq(notificationLog.operatorId, operators.id))),
        ),
      ),
    )
    .orderBy(asc(cases.publishedAt), asc(cases.id))
    .limit(limit);
  for (const row of reminders) {
    const stage = row.publishedAt === null ? 0 : reminderStage(row.publishedAt, now);
    if (stage === 0) continue;
    await deliver(row, `reminder_${stage}`, row.caseId, { kind: "reminder", stage, count: row.waiting, caseId: row.caseId });
  }

  // 2. New arguments, made in the window, by an agent of someone else.
  const arguer = alias(agents, "arguer");
  const arguments_ = await db
    .select({ id: argumentsTable.id, caseId: argumentsTable.caseId, ...recipient })
    .from(argumentsTable)
    .innerJoin(cases, eq(cases.id, argumentsTable.caseId))
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .innerJoin(arguer, eq(arguer.id, argumentsTable.agentId))
    .where(
      and(
        eq(argumentsTable.status, "active"),
        gte(argumentsTable.createdAt, windowStart),
        lte(argumentsTable.createdAt, now),
        inArray(cases.status, ["open", "argued"]),
        ne(arguer.operatorId, operators.id),
        notExists(db.select({ one: sql`1` }).from(notificationLog).where(and(eq(notificationLog.kind, "new_argument"), eq(notificationLog.targetId, argumentsTable.id), eq(notificationLog.operatorId, operators.id)))),
      ),
    )
    .orderBy(asc(argumentsTable.createdAt), asc(argumentsTable.id))
    .limit(limit);
  for (const row of arguments_) await deliver(row, "new_argument", row.id, { kind: "new_argument", caseId: row.caseId });

  // 3. Appeals decided in the window.
  const decided = await db
    .select({ id: verdicts.id, caseId: verdicts.caseId, outcome: verdicts.appealOutcome, ...recipient })
    .from(verdicts)
    .innerJoin(cases, eq(cases.id, verdicts.caseId))
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(
      and(
        isNotNull(verdicts.appealOutcome),
        isNotNull(verdicts.appealResolvedAt),
        gte(verdicts.appealResolvedAt, windowStart),
        lte(verdicts.appealResolvedAt, now),
        notExists(db.select({ one: sql`1` }).from(notificationLog).where(and(eq(notificationLog.kind, "appeal_outcome"), eq(notificationLog.targetId, verdicts.id), eq(notificationLog.operatorId, operators.id)))),
      ),
    )
    .orderBy(asc(verdicts.appealResolvedAt), asc(verdicts.id))
    .limit(limit);
  for (const row of decided) {
    if (row.outcome === null) continue;
    await deliver(row, "appeal_outcome", row.id, { kind: "appeal_outcome", outcome: row.outcome, caseId: row.caseId });
  }

  // 4. Cases closed in the window.
  const closed = await db
    .select({ caseId: cases.id, ...recipient })
    .from(auditLog)
    .innerJoin(cases, sql`${cases.id}::text = ${auditLog.target}`)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(
      and(
        eq(auditLog.action, "case.closed"),
        gte(auditLog.createdAt, windowStart),
        lte(auditLog.createdAt, now),
        eq(cases.status, "closed_unresolved"),
        notExists(db.select({ one: sql`1` }).from(notificationLog).where(and(eq(notificationLog.kind, "case_closed"), eq(notificationLog.targetId, cases.id), eq(notificationLog.operatorId, operators.id)))),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(cases.id))
    .limit(limit);
  for (const row of closed) await deliver(row, "case_closed", row.caseId, { kind: "case_closed", caseId: row.caseId });

  return summary;
}
