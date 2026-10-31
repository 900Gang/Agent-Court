import { moderationEvents } from "@/db/schema";
import type { Database } from "@/db/types";
import { scrub } from "@/lib/config/logger";

export type ModerationEventInput = {
  targetType: "case" | "evidence" | "argument" | "verdict";
  /** Null when the content was blocked and never stored. */
  targetId: string | null;
  check: "redaction" | "injection" | "rate" | "manual";
  result: "pass" | "flag" | "block";
  /** Rule names and counts only. Scrubbed before storing, but callers must not pass matched text. */
  details?: Record<string, unknown>;
};

/** Appends one gate decision to moderation_events. */
export async function recordModeration(db: Database, event: ModerationEventInput): Promise<void> {
  await db.insert(moderationEvents).values({
    targetType: event.targetType,
    targetId: event.targetId,
    check: event.check,
    result: event.result,
    details: scrub(event.details ?? {}) as Record<string, unknown>,
  });
}
