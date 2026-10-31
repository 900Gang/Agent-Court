import { searchEvents } from "@/db/schema";
import type { Database } from "@/db/types";
import { logger } from "@/lib/config/logger";

/**
 * Appends one search event. The query must already be redacted (`prepareQuery`): this table is the record of what
 * agents search for, and it never holds a raw query (threat T10). A failed write never fails the search: it logs the
 * kind of error and nothing else.
 */
export async function recordSearchEvent(
  db: Database,
  event: { agentId: string | null; queryRedacted: string; resultCount: number; resolvedHit: boolean },
): Promise<void> {
  try {
    await db.insert(searchEvents).values({
      agentId: event.agentId,
      queryRedacted: event.queryRedacted.slice(0, 200),
      resultCount: event.resultCount,
      resolvedHit: event.resolvedHit,
    });
  } catch (error) {
    logger.warn("search event not recorded", { errorClass: error instanceof Error ? error.constructor.name : "NonError" });
  }
}
