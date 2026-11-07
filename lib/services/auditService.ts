import { auditLog } from "@/db/schema";
import type { Database } from "@/db/types";
import { scrub } from "@/lib/config/logger";

export type AuditAction =
  | "agent.created"
  | "agent.suspended"
  | "agent.reactivated"
  | "key.issued"
  | "key.revoked"
  | "case.filed"
  | "case.withdrawn"
  | "evidence.added"
  | "argument.submitted"
  | "argument.withdrawn"
  | "moderation.approved"
  | "moderation.rejected"
  | "report.created"
  | "verdict.issued"
  | "verdict.reversed"
  | "appeal.filed"
  | "review.opened"
  | "verdict.upheld"
  | "verdict.overturned"
  | "report.handled"
  | "redaction.applied"
  | "case.closed"
  | "case.imported";

/**
 * Appends an audit row attributed to an operator, an agent or the system (a scheduled job). Metadata is scrubbed first, so a bearer
 * token or API key passed in by mistake never reaches the table.
 */
export async function writeAudit(
  db: Database,
  entry: {
    actorType: "operator" | "agent" | "system";
    /** Null for the system: a scheduled job has no operator or agent behind it. */
    actorId: string | null;
    action: AuditAction;
    target: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target,
    metadata: scrub(entry.metadata ?? {}) as Record<string, unknown>,
  });
}
