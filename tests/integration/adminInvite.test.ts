import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { addInviteCore, removeInviteCore, type InviteDeps } from "@/lib/admin/inviteCore";
import { GithubLookupError, type GithubLookup } from "@/lib/github/lookup";
import { isInvited } from "@/lib/services/inviteService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N11 Task 1 (AC-1107): the form handlers behind /admin/invites. Order, as for every admin action: same-origin check,
// then the admin check (anyone else gets the answer a missing sign-in gets), then the input, then the service.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";

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
  await t.sql("truncate operator_invites, audit_log");
  await t.sql("set role app_server");
});

async function makeOperator(role: "operator" | "admin" = "admin"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Operator", role, status: "active" }).returning();
  return row;
}

const lookup: GithubLookup = async (login) => {
  if (login.toLowerCase() === "octocat") return { id: "583231", login: "octocat" };
  throw new GithubLookupError("not_found");
};

const deps = (operator: Operator | null, over: Partial<InviteDeps> = {}): InviteDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  lookup,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

const codeOf = (result: { ok: boolean; error?: { code: string } }): string => {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
};

describe("addInviteCore", () => {
  it("invites an account for an admin", async () => {
    const admin = await makeOperator();
    const result = await addInviteCore(deps(admin), { login: "octocat" });
    expect(result).toEqual({ ok: true, value: { githubId: "583231", githubLogin: "octocat", added: true } });
    expect(await isInvited(t.db, "583231")).toBe(true);
  });

  it("removes spaces and one leading @ before it looks at the login", async () => {
    const admin = await makeOperator();
    expect((await addInviteCore(deps(admin), { login: "  @octocat  " })).ok).toBe(true);
  });

  it("says added: false for an account that is already invited", async () => {
    const admin = await makeOperator();
    await addInviteCore(deps(admin), { login: "octocat" });
    expect(await addInviteCore(deps(admin), { login: "octocat" })).toMatchObject({ ok: true, value: { added: false } });
  });

  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin, and asks GitHub nothing", async (_label, over) => {
    const admin = await makeOperator();
    const spy = vi.fn(lookup);
    expect(codeOf(await addInviteCore(deps(admin, { ...over, lookup: spy }), { login: "octocat" }))).toBe("origin_mismatch");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["nobody signed in", () => Promise.resolve(null)],
    ["an ordinary operator", () => makeOperator("operator")],
  ])("answers %s as a missing sign-in, and asks GitHub nothing", async (_label, make) => {
    const spy = vi.fn(lookup);
    expect(codeOf(await addInviteCore(deps(await make(), { lookup: spy }), { login: "octocat" }))).toBe("not_signed_in");
    expect(spy).not.toHaveBeenCalled();
    expect(await t.sql("select 1 from operator_invites")).toHaveLength(0);
  });

  it.each([
    ["a login that is not valid", "not a login", "invalid_login"],
    ["an empty login", "", "invalid_login"],
    ["only an @", "@", "invalid_login"],
    ["a login GitHub does not know", "nobody-here", "github_not_found"],
  ])("answers %s with a fixed code", async (_label, login, code) => {
    const admin = await makeOperator();
    expect(codeOf(await addInviteCore(deps(admin), { login }))).toBe(code);
  });

  it("answers github_unavailable when GitHub cannot be reached", async () => {
    const admin = await makeOperator();
    const down: GithubLookup = async () => {
      throw new GithubLookupError("unavailable");
    };
    expect(codeOf(await addInviteCore(deps(admin, { lookup: down }), { login: "octocat" }))).toBe("github_unavailable");
  });

  it("copes with an input that is not a string", async () => {
    const admin = await makeOperator();
    expect(codeOf(await addInviteCore(deps(admin), { login: undefined as never }))).toBe("invalid_login");
  });
});

describe("removeInviteCore", () => {
  it("removes an invite for an admin", async () => {
    const admin = await makeOperator();
    await addInviteCore(deps(admin), { login: "octocat" });
    expect(await removeInviteCore(deps(admin), { githubId: "583231" })).toEqual({ ok: true, value: { removed: true } });
    expect(await isInvited(t.db, "583231")).toBe(false);
  });

  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else", async (_label, over) => {
    const admin = await makeOperator();
    await addInviteCore(deps(admin), { login: "octocat" });
    expect(codeOf(await removeInviteCore(deps(admin, over), { githubId: "583231" }))).toBe("origin_mismatch");
    expect(await isInvited(t.db, "583231")).toBe(true);
  });

  it("answers an ordinary operator as a missing sign-in", async () => {
    const admin = await makeOperator();
    await addInviteCore(deps(admin), { login: "octocat" });
    expect(codeOf(await removeInviteCore(deps(await makeOperator("operator")), { githubId: "583231" }))).toBe("not_signed_in");
    expect(await isInvited(t.db, "583231")).toBe(true);
  });

  it("refuses an id that is not a run of digits", async () => {
    const admin = await makeOperator();
    expect(codeOf(await removeInviteCore(deps(admin), { githubId: "abc" }))).toBe("invalid");
  });
});
