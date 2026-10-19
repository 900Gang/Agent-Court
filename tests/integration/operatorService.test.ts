import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkOperatorToUser, promoteToAdmin, recordGithubLogin } from "@/lib/services/operatorService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

const now = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number, from = now) => new Date(from.getTime() - days * 86_400_000);

function login(overrides: Partial<Parameters<typeof recordGithubLogin>[1]> = {}) {
  return {
    githubId: uniq("gh"),
    githubCreatedAt: daysAgo(400),
    email: "ada@example.test",
    emailVerified: true,
    displayName: "Ada",
    ...overrides,
  };
}

async function rowsFor(githubId: string) {
  return t.sql(`select * from operators where github_id = $1`, [githubId]);
}

describe("recordGithubLogin", () => {
  it("creates an active operator for an old account with a verified email", async () => {
    const input = login();
    const operator = await recordGithubLogin(t.db, input, now);
    expect(operator).toMatchObject({
      githubId: input.githubId,
      status: "active",
      role: "operator",
      displayName: "Ada",
      email: "ada@example.test",
    });
    expect(operator.verifiedAt).not.toBeNull();
    expect(operator.githubCreatedAt).toEqual(input.githubCreatedAt);
    expect(operator.authUserId).toBeNull();
  });

  it("creates a pending operator for an account under 30 days old", async () => {
    const operator = await recordGithubLogin(t.db, login({ githubCreatedAt: daysAgo(29) }), now);
    expect(operator.status).toBe("pending");
    expect(operator.verifiedAt).toBeNull();
  });

  it("creates a pending operator when the email is not verified", async () => {
    const operator = await recordGithubLogin(t.db, login({ emailVerified: false }), now);
    expect(operator.status).toBe("pending");
  });

  it("creates a pending operator, without throwing, when the creation date is missing", async () => {
    const operator = await recordGithubLogin(t.db, login({ githubCreatedAt: null }), now);
    expect(operator.status).toBe("pending");
    expect(operator.githubCreatedAt).toBeNull();
  });

  it("does not create a second row for the same GitHub account", async () => {
    const input = login();
    const first = await recordGithubLogin(t.db, input, now);
    const second = await recordGithubLogin(t.db, input, now);
    expect(second.id).toBe(first.id);
    expect(await rowsFor(input.githubId)).toHaveLength(1);
  });

  it("updates email and display name on a later login", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const updated = await recordGithubLogin(
      t.db,
      { ...input, email: "new@example.test", displayName: "Ada Lovelace" },
      now,
    );
    expect(updated).toMatchObject({ email: "new@example.test", displayName: "Ada Lovelace" });
  });

  it("promotes a pending operator once the account is 30 days old", async () => {
    const input = login({ githubCreatedAt: daysAgo(10) });
    const first = await recordGithubLogin(t.db, input, now);
    expect(first.status).toBe("pending");

    const later = new Date(now.getTime() + 21 * 86_400_000);
    const promoted = await recordGithubLogin(t.db, input, later);
    expect(promoted.status).toBe("active");
    expect(promoted.verifiedAt).not.toBeNull();
  });

  it("promotes a pending operator once the email is verified", async () => {
    const input = login({ emailVerified: false });
    expect((await recordGithubLogin(t.db, input, now)).status).toBe("pending");
    expect((await recordGithubLogin(t.db, { ...input, emailVerified: true }, now)).status).toBe("active");
  });

  it("never changes a suspended operator", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    await t.sql(`update operators set status = 'suspended' where github_id = $1`, [input.githubId]);
    const again = await recordGithubLogin(t.db, input, now);
    expect(again.status).toBe("suspended");
  });

  it("does not demote an active operator", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const again = await recordGithubLogin(t.db, { ...input, emailVerified: false }, now);
    expect(again.status).toBe("active");
  });

  it("never changes an admin role", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    await t.sql(`update operators set role = 'admin' where github_id = $1`, [input.githubId]);
    const again = await recordGithubLogin(t.db, input, now);
    expect(again.role).toBe("admin");
  });

  it("keeps a stored creation date when a later login has none", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const again = await recordGithubLogin(t.db, { ...input, githubCreatedAt: null }, now);
    expect(again.githubCreatedAt).toEqual(input.githubCreatedAt);
    expect(again.status).toBe("active");
  });
});

describe("linkOperatorToUser", () => {
  async function insertUser(): Promise<string> {
    const id = uniq("user");
    await t.sql(`insert into "user" (id, name, email) values ($1, 'Name', $2)`, [id, `${id}@example.test`]);
    return id;
  }

  async function insertGithubAccount(userId: string, githubId: string) {
    await t.sql(
      `insert into account (id, account_id, provider_id, user_id) values ($1, $2, 'github', $3)`,
      [uniq("acc"), githubId, userId],
    );
  }

  it("links the operator that matches the user's GitHub account", async () => {
    const input = login();
    const operator = await recordGithubLogin(t.db, input, now);
    const userId = await insertUser();
    await insertGithubAccount(userId, input.githubId);

    const linked = await linkOperatorToUser(t.db, userId);
    expect(linked?.id).toBe(operator.id);
    expect(linked?.authUserId).toBe(userId);
    expect((await rowsFor(input.githubId))[0].auth_user_id).toBe(userId);
  });

  it("is idempotent for the same user", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const userId = await insertUser();
    await insertGithubAccount(userId, input.githubId);
    await linkOperatorToUser(t.db, userId);
    expect((await linkOperatorToUser(t.db, userId))?.authUserId).toBe(userId);
  });

  it("never overwrites an existing link to another user", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const first = await insertUser();
    const second = await insertUser();
    await insertGithubAccount(first, input.githubId);
    await insertGithubAccount(second, input.githubId);

    await linkOperatorToUser(t.db, first);
    expect(await linkOperatorToUser(t.db, second)).toBeNull();
    expect((await rowsFor(input.githubId))[0].auth_user_id).toBe(first);
  });

  it("returns null when the user has no GitHub account", async () => {
    expect(await linkOperatorToUser(t.db, await insertUser())).toBeNull();
  });

  it("returns null when no operator exists for the GitHub account", async () => {
    const userId = await insertUser();
    await insertGithubAccount(userId, uniq("unknown-gh"));
    expect(await linkOperatorToUser(t.db, userId)).toBeNull();
  });
});
describe("promoteToAdmin", () => {
  it("makes an existing operator an admin and returns it", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    const promoted = await promoteToAdmin(t.db, input.githubId);
    expect(promoted?.role).toBe("admin");
    expect((await rowsFor(input.githubId))[0].role).toBe("admin");
  });

  it("is safe to run twice", async () => {
    const input = login();
    await recordGithubLogin(t.db, input, now);
    await promoteToAdmin(t.db, input.githubId);
    expect((await promoteToAdmin(t.db, input.githubId))?.role).toBe("admin");
  });

  it("returns null for a GitHub id that has never logged in", async () => {
    expect(await promoteToAdmin(t.db, uniq("nobody"))).toBeNull();
  });

  it("does not change the operator's status", async () => {
    const input = login({ githubCreatedAt: daysAgo(5) });
    await recordGithubLogin(t.db, input, now);
    expect((await promoteToAdmin(t.db, input.githubId))?.status).toBe("pending");
  });
});
