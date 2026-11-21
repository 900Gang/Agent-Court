import { count, desc, eq, inArray } from "drizzle-orm";
import { operatorInvites, operators } from "@/db/schema";
import type { Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import { INVITES } from "@/lib/config/constants";
import { isValidGithubLogin, GithubLookupError, type GithubLookup } from "@/lib/github/lookup";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";

// The allowlist behind invite-only access (N11, AC-1107). The one file that names the operator_invites table.

/** Whether this GitHub account has been invited. */
export async function isInvited(db: Database, githubId: string): Promise<boolean> {
  const [row] = await db.select({ id: operatorInvites.id }).from(operatorInvites).where(eq(operatorInvites.githubId, githubId)).limit(1);
  return row !== undefined;
}

export type InviteState = "not_signed_in" | "pending" | "active" | "suspended";

export type InviteRow = {
  githubId: string;
  githubLogin: string;
  /** The display name of the administrator who invited, or null if that operator is gone. */
  invitedBy: string | null;
  createdAt: Date;
  /** Whether the invited person has signed in, and what their account is now. */
  state: InviteState;
};

/** The invites, newest first, with the state of each person. At most INVITES.max rows. */
export async function listInvites(db: Database): Promise<InviteRow[]> {
  const rows = await db
    .select({
      githubId: operatorInvites.githubId,
      githubLogin: operatorInvites.githubLogin,
      createdAt: operatorInvites.createdAt,
      inviterId: operatorInvites.invitedBy,
    })
    .from(operatorInvites)
    .orderBy(desc(operatorInvites.createdAt), desc(operatorInvites.id))
    .limit(INVITES.max);
  if (rows.length === 0) return [];

  const people = await db
    .select({ githubId: operators.githubId, status: operators.status })
    .from(operators)
    .where(inArray(operators.githubId, rows.map((row) => row.githubId)));
  const inviterIds = [...new Set(rows.flatMap((row) => (row.inviterId ? [row.inviterId] : [])))];
  const inviters = inviterIds.length === 0 ? [] : await db.select({ id: operators.id, displayName: operators.displayName }).from(operators).where(inArray(operators.id, inviterIds));
  const byGithub = new Map(people.map((person) => [person.githubId, person]));
  const byId = new Map(inviters.map((person) => [person.id, person]));
  return rows.map((row) => {
    const person = byGithub.get(row.githubId);
    return {
      githubId: row.githubId,
      githubLogin: row.githubLogin,
      invitedBy: row.inviterId ? (byId.get(row.inviterId)?.displayName ?? null) : null,
      createdAt: row.createdAt,
      state: person ? person.status : "not_signed_in",
    };
  });
}

type AddResult = ServiceResult<{ githubId: string; githubLogin: string; added: boolean }, "forbidden" | "invalid_login" | "github_not_found" | "github_unavailable" | "invite_limit">;

async function currentAdmin(db: Database, admin: Operator): Promise<Operator | null> {
  const [current] = await db.select().from(operators).where(eq(operators.id, admin.id)).limit(1);
  return current && isActiveAdmin(current) ? current : null;
}

/**
 * An administrator invites a GitHub account by login. The admin is read from the database again, the login is checked
 * against GitHub's pattern, and GitHub is asked once for the numeric id (outside the transaction, so no connection waits
 * on the network). Inviting someone who is already invited changes nothing and writes nothing.
 */
export async function addInvite(db: Database, admin: Operator, login: string, lookup: GithubLookup): Promise<AddResult> {
  const current = await currentAdmin(db, admin);
  if (!current) return fail("forbidden");
  if (!isValidGithubLogin(login)) return fail("invalid_login");

  let account;
  try {
    account = await lookup(login);
  } catch (error) {
    const code = error instanceof GithubLookupError ? error.code : "unavailable";
    return fail(code === "invalid_login" ? "invalid_login" : code === "not_found" ? "github_not_found" : "github_unavailable");
  }

  return db.transaction(async (tx): Promise<AddResult> => {
    const [existing] = await tx.select({ login: operatorInvites.githubLogin }).from(operatorInvites).where(eq(operatorInvites.githubId, account.id)).limit(1);
    if (existing) return ok({ githubId: account.id, githubLogin: existing.login, added: false });

    const [total] = await tx.select({ n: count() }).from(operatorInvites);
    if (Number(total?.n ?? 0) >= INVITES.max) return fail("invite_limit");

    const [inserted] = await tx
      .insert(operatorInvites)
      .values({ githubId: account.id, githubLogin: account.login, invitedBy: current.id })
      .onConflictDoNothing({ target: operatorInvites.githubId })
      .returning({ id: operatorInvites.id });
    if (!inserted) return ok({ githubId: account.id, githubLogin: account.login, added: false });

    await writeAudit(tx, {
      actorType: "operator",
      actorId: current.id,
      action: "invite.added",
      target: account.id,
      metadata: { login: account.login },
    });
    return ok({ githubId: account.id, githubLogin: account.login, added: true });
  });
}

type RemoveResult = ServiceResult<{ removed: boolean }, "forbidden" | "invalid">;

/** An administrator removes an invite. Someone who is already an operator is not touched: use suspension for that. */
export async function removeInvite(db: Database, admin: Operator, githubId: string): Promise<RemoveResult> {
  const current = await currentAdmin(db, admin);
  if (!current) return fail("forbidden");
  if (typeof githubId !== "string" || !/^[0-9]{1,20}$/.test(githubId)) return fail("invalid");

  return db.transaction(async (tx): Promise<RemoveResult> => {
    const [removed] = await tx.delete(operatorInvites).where(eq(operatorInvites.githubId, githubId)).returning({ login: operatorInvites.githubLogin });
    if (!removed) return ok({ removed: false });
    await writeAudit(tx, {
      actorType: "operator",
      actorId: current.id,
      action: "invite.removed",
      target: githubId,
      metadata: { login: removed.login },
    });
    return ok({ removed: true });
  });
}
