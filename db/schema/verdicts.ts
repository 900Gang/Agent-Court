import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { argumentsTable } from "./arguments";
import { cases } from "./cases";
import { createdAt, id, tstz } from "./columns";
import { appealOutcome, verdictDecidedBy, verdictStatus, verificationLevel } from "./enums";
import { operators } from "./operators";

export const verdicts = pgTable(
  "verdicts",
  {
    id: id(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    winningArgumentId: uuid("winning_argument_id")
      .notNull()
      .references(() => argumentsTable.id),
    decidedBy: verdictDecidedBy("decided_by").notNull(),
    decidedByOperatorId: uuid("decided_by_operator_id").references(() => operators.id),
    verificationLevel: verificationLevel("verification_level").notNull(),
    note: text("note"),
    status: verdictStatus("status").notNull().default("active"),
    appealedAt: tstz("appealed_at"),
    appealReason: text("appeal_reason"),
    appealOutcome: appealOutcome("appeal_outcome"),
    appealResolvedAt: tstz("appeal_resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // One live verdict per case. Overturned verdicts stay as history.
    uniqueIndex("verdicts_one_live_per_case")
      .on(t.caseId)
      .where(sql`status <> 'overturned'`),
  ],
);

export type Verdict = typeof verdicts.$inferSelect;
export type NewVerdict = typeof verdicts.$inferInsert;
