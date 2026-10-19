import { auditLog } from "@/db/schema";
import type { Database } from "@/db/types";
import { scrub } from "@/lib/config/logger";

export type AuditAction =
  | "agent.created"
  | "agent.suspended"
  | "agent.reactivated"
  | "key.issued"
  | "key.revoked";

/**
 * Appends an audit row attributed to an operator. Metadata is scrubbed first, so a bearer
 * token or API key passed in by mistake never reaches the table.
 */
export async function writeAudit(
  db: Database,
  entry: {
    actorOperatorId: string;
    action: AuditAction;
    target: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "operator",
    actorId: entry.actorOperatorId,
    action: entry.action,
    target: entry.target,
    metadata: scrub(entry.metadata ?? {}) as Record<string, unknown>,
  });
}
