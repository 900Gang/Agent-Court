import { and, eq, isNull, or } from "drizzle-orm";
import { account, operators, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";

export const MIN_GITHUB_ACCOUNT_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

/** Operator trust floor: GitHub account at least 30 days old and a verified email. */
export function evaluateTrust(input: {
  githubCreatedAt: Date | null;
  emailVerified: boolean;
  now?: Date;
}): "active" | "pending" {
  if (!input.emailVerified || input.githubCreatedAt === null) return "pending";
  const now = input.now ?? new Date();
  const age = now.getTime() - input.githubCreatedAt.getTime();
  return age >= MIN_GITHUB_ACCOUNT_AGE_DAYS * DAY_MS ? "active" : "pending";
}

export interface GithubLogin {
  githubId: string;
  githubCreatedAt: Date | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

/**
 * Creates or refreshes the operator for a GitHub login, keyed by GitHub id.
 * Pending operators are promoted when trust now passes. Active and suspended operators
 * keep their status, and `role` is never touched: admins are set by hand.
 */
export async function recordGithubLogin(
  db: Database,
  input: GithubLogin,
  now: Date = new Date(),
): Promise<Operator> {
  const trust = evaluateTrust({
    githubCreatedAt: input.githubCreatedAt,
    emailVerified: input.emailVerified,
    now,
  });

  let [current] = await db
    .select()
    .from(operators)
    .where(eq(operators.githubId, input.githubId))
    .limit(1);

  if (!current) {
    const [created] = await db
      .insert(operators)
      .values({
        githubId: input.githubId,
        githubCreatedAt: input.githubCreatedAt,
        email: input.email,
        displayName: input.displayName,
        status: trust,
        verifiedAt: trust === "active" ? now : null,
      })
      .onConflictDoNothing({ target: operators.githubId })
      .returning();
    if (created) return created;

    // A concurrent first login inserted the row between our read and write.
    [current] = await db
      .select()
      .from(operators)
      .where(eq(operators.githubId, input.githubId))
      .limit(1);
    if (!current) throw new Error("Could not record operator");
  }

  const githubCreatedAt = input.githubCreatedAt ?? current.githubCreatedAt;
  const promote =
    current.status === "pending" &&
    evaluateTrust({ githubCreatedAt, emailVerified: input.emailVerified, now }) === "active";

  const [updated] = await db
    .update(operators)
    .set({
      email: input.email ?? current.email,
      displayName: input.displayName,
      githubCreatedAt,
      ...(promote ? { status: "active" as const, verifiedAt: now } : {}),
    })
    .where(eq(operators.id, current.id))
    .returning();
  return updated;
}

/**
 * Links the Better Auth user to the operator with the same GitHub id. Only fills an empty
 * link: an operator already linked to another user is never re-pointed.
 */
export async function linkOperatorToUser(db: Database, authUserId: string): Promise<Operator | null> {
  const [githubAccount] = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, authUserId), eq(account.providerId, "github")))
    .limit(1);
  if (!githubAccount) return null;

  const [linked] = await db
    .update(operators)
    .set({ authUserId })
    .where(
      and(
        eq(operators.githubId, githubAccount.accountId),
        or(isNull(operators.authUserId), eq(operators.authUserId, authUserId)),
      ),
    )
    .returning();
  return linked ?? null;
}

/** Makes the operator with this GitHub id an admin. Run by hand through scripts/make-admin.ts; the app never promotes anyone. */
export async function promoteToAdmin(db: Database, githubId: string): Promise<Operator | null> {
  const [promoted] = await db
    .update(operators)
    .set({ role: "admin" })
    .where(eq(operators.githubId, githubId))
    .returning();
  return promoted ?? null;
}
