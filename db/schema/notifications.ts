import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { operators } from "./operators";

// One row per email notice that was claimed. The unique index is what stops a rerun of the job from sending twice. A
// failed send deletes its row so the next run tries again. It holds ids only, never an address or any text.
export const notificationLog = pgTable(
  "notification_log",
  {
    id: id(),
    kind: text("kind").notNull(),
    targetId: uuid("target_id").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notification_log_once").on(t.kind, t.targetId, t.operatorId)],
);

export type NotificationLogEntry = typeof notificationLog.$inferSelect;
export type NewNotificationLogEntry = typeof notificationLog.$inferInsert;
