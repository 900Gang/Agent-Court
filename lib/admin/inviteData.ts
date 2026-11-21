import "server-only";
import { getDb } from "@/db/client";
import { getServerEnv } from "@/lib/config/env";
import { listInvites, type InviteRow } from "@/lib/services/inviteService";

export type InvitesPageData = {
  /** Whether the court is invite-only in this deployment (the INVITE_ONLY setting, with its default). */
  inviteOnly: boolean;
  invites: InviteRow[];
};

/** Everything /admin/invites shows, from the real database. Pages go through here instead of importing the database. */
export async function loadInvitesPage(): Promise<InvitesPageData> {
  return { inviteOnly: getServerEnv().inviteOnly, invites: await listInvites(getDb()) };
}
