import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { operators } from "./operators";

// The GitHub accounts an administrator has invited (N11, AC-1107). The id is what is matched, because a login can be
// renamed and an id cannot; the login is kept for display. Only lib/services/inviteService.ts reads or writes this table
// (`check:routes` rule 10). It holds no text that anyone wrote except the login GitHub itself returned.
export const operatorInvites = pgTable("operator_invites", {
  id: id(),
  githubId: text("github_id").notNull().unique(),
  githubLogin: text("github_login").notNull(),
  invitedBy: uuid("invited_by").references(() => operators.id),
  createdAt: createdAt(),
});

export type OperatorInvite = typeof operatorInvites.$inferSelect;
