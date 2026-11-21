import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "@/lib/services/agentService";
import { issueKey } from "@/lib/services/keyService";
import { recordGithubLogin, type GithubLogin } from "@/lib/services/operatorService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N11 Task 1 (AC-1107): invite-only access is decided in recordGithubLogin, and nowhere else.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const now = new Date("2026-11-21T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate operator_invites");
  await t.sql("set role app_server");
});

const login = (over: Partial<GithubLogin> = {}): GithubLogin => ({
  githubId: f.uniq("9"),
  githubCreatedAt: daysAgo(400),
  email: "person@example.test",
  emailVerified: true,
  displayName: "Person",
  ...over,
});

async function invite(githubId: string) {
  await t.sql("reset role");
  await t.sql("insert into operator_invites (github_id, github_login) values ($1, 'someone')", [githubId]);
  await t.sql("set role app_server");
}
async function uninvite(githubId: string) {
  await t.sql("reset role");
  await t.sql("delete from operator_invites where github_id = $1", [githubId]);
  await t.sql("set role app_server");
}

describe("with invite-only off", () => {
  it("changes nothing: the trust floor alone decides", async () => {
    expect((await recordGithubLogin(t.db, login(), now)).status).toBe("active");
    expect((await recordGithubLogin(t.db, login(), now, { inviteOnly: false })).status).toBe("active");
    expect((await recordGithubLogin(t.db, login({ githubCreatedAt: daysAgo(5) }), now, { inviteOnly: false })).status).toBe("pending");
  });

  it("does not look at the invite list at all", async () => {
    const input = login();
    await invite("somebody-else");
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: false })).status).toBe("active");
  });
});

describe("with invite-only on", () => {
  it("leaves a new operator who was not invited pending, even if they pass the trust floor", async () => {
    const operator = await recordGithubLogin(t.db, login(), now, { inviteOnly: true });
    expect(operator.status).toBe("pending");
    expect(operator.verifiedAt).toBeNull();
  });

  it("makes a new operator who was invited active, if they pass the trust floor", async () => {
    const input = login();
    await invite(input.githubId);
    const operator = await recordGithubLogin(t.db, input, now, { inviteOnly: true });
    expect(operator.status).toBe("active");
    expect(operator.verifiedAt).toEqual(now);
  });

  it("still needs the trust floor: an invite does not skip it", async () => {
    const young = login({ githubCreatedAt: daysAgo(5) });
    await invite(young.githubId);
    expect((await recordGithubLogin(t.db, young, now, { inviteOnly: true })).status).toBe("pending");
    const unverified = login({ emailVerified: false });
    await invite(unverified.githubId);
    expect((await recordGithubLogin(t.db, unverified, now, { inviteOnly: true })).status).toBe("pending");
  });

  it("promotes a pending operator at the next sign-in once they have been invited", async () => {
    const input = login();
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("pending");
    await invite(input.githubId);
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("active");
  });

  it("matches the GitHub id, not the name: an invite for another id does nothing", async () => {
    const input = login();
    await invite(input.githubId + "0");
    await invite("1" + input.githubId);
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("pending");
  });

  it("never makes an operator who is already active pending, with or without an invite", async () => {
    const input = login();
    expect((await recordGithubLogin(t.db, input, now)).status).toBe("active"); // let in before the setting was on
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("active");
    await invite(input.githubId);
    await uninvite(input.githubId);
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("active");
  });

  it("never reactivates a suspended operator, even an invited one", async () => {
    const input = login();
    await invite(input.githubId);
    await recordGithubLogin(t.db, input, now, { inviteOnly: true });
    await t.sql("reset role");
    await t.sql("update operators set status = 'suspended' where github_id = $1", [input.githubId]);
    await t.sql("set role app_server");
    expect((await recordGithubLogin(t.db, input, now, { inviteOnly: true })).status).toBe("suspended");
  });
});

describe("what a not-invited operator can do", () => {
  it("cannot register an agent or issue a key; an invited one can", async () => {
    const outsider = await recordGithubLogin(t.db, login(), now, { inviteOnly: true });
    expect(outsider.status).toBe("pending");
    expect(f.errorOf(await createAgent(t.db, outsider, { handle: f.uniq("outsider") }))).toBe("operator_not_active");

    const input = login();
    await invite(input.githubId);
    const insider = await recordGithubLogin(t.db, input, now, { inviteOnly: true });
    const agent = f.unwrap(await createAgent(t.db, insider, { handle: f.uniq("insider") }));
    expect((await issueKey(t.db, insider, agent.id, { scopes: ["read"] })).ok).toBe(true);
    // the outsider cannot issue a key for the insider's agent, nor for anything
    expect((await issueKey(t.db, outsider, agent.id, { scopes: ["read"] })).ok).toBe(false);
  });
});
