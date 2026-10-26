import "server-only";
import { getDb } from "@/db/client";
import { loadModerationQueue, type ModerationQueue } from "./queue";

/** The moderation queue from the real database. Pages go through here instead of importing the database. */
export function loadQueue(): Promise<ModerationQueue> {
  return loadModerationQueue(getDb());
}
