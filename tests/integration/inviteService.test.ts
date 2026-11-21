import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { INVITES } from "@/lib/config/constants";
import { GithubLookupError, type GithubLookup } from "@/lib/github/lookup";
import { addInvite, isInvited, listInvites, removeInvite } from "@/lib/services/inviteService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N11 Task 1 (AC-1107): the invite allowlist, against the in-memory database and an injected GitHub lookup.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;

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

async function makeOperator(role: "operator" | "admin" = "admin", status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Operator", role, status }).returning();
  return row;
}

/** A lookup that knows a fixed set of accounts. */
const known = (accounts: Record<string, { id: string; login?: string }>): GithubLookup => async (login) => {
  const hit = accounts[login.toLowerCase()];
  if (!hit) throw new GithubLookupError("not_found");
  return { id: hit.id, login: hit.login ?? login };
};

const audit = (action: string) => t.sql("select * from audit_log where action = $1 order by created_at", [action]);

describe("addInvite", () => {
  it("invites an account by the id GitHub returns, and says who invited", async () => {
    const admin = await makeOperator();
    const result = await addInvite(t.db, admin, "octocat", known({ octocat: { id: "583231", login: "octocat" } }));
    expect(result).toEqual({ ok: true, value: { githubId: "583231", githubLogin: "octocat", added: true } });
    expect(await isInvited(t.db, "583231")).toBe(true);
    const [row] = await t.sql("select * from operator_invites");
    expect(row.invited_by).toBe(admin.id);
    expect(row.github_login).toBe("octocat");
  });

  it("writes one audit row with the admin's id, the GitHub id and the login", async () => {
    const admin = await makeOperator();
    await addInvite(t.db, admin, "octocat", known({ octocat: { id: "583231" } }));
    const rows = await audit("invite.added");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "operator", actor_id: admin.id, target: "583231" });
    expect(rows[0].metadata).toEqual({ login: "octocat" });
  });

  it("stores the login as GitHub spells it", async () => {
    const admin = await makeOperator();
    await addInvite(t.db, admin, "octocat", known({ octocat: { id: "5", login: "OctoCat" } }));
    expect((await listInvites(t.db))[0].githubLogin).toBe("OctoCat");
  });

  it("changes nothing and writes nothing when the account is already invited", async () => {
    const admin = await makeOperator();
    const lookup = known({ octocat: { id: "583231" } });
    await addInvite(t.db, admin, "octocat", lookup);
    const again = await addInvite(t.db, admin, "octocat", lookup);
    expect(again).toEqual({ ok: true, value: { githubId: "583231", githubLogin: "octocat", added: false } });
    expect(await t.sql("select 1 from operator_invites")).toHaveLength(1);
    expect(await audit("invite.added")).toHaveLength(1);
  });

  it("recognises the same account under a different spelling of the login", async () => {
    const admin = await makeOperator();
    await addInvite(t.db, admin, "octocat", known({ octocat: { id: "583231", login: "octocat" }, octocat2: { id: "583231", login: "OctoCat" } }));
    const again = await addInvite(t.db, admin, "octocat2", known({ octocat2: { id: "583231", login: "OctoCat" } }));
    expect(again).toMatchObject({ ok: true, value: { added: false } });
    expect(await t.sql("select 1 from operator_invites")).toHaveLength(1);
  });

  it.each([
    ["an ordinary operator", () => makeOperator("operator")],
    ["a suspended admin", () => makeOperator("admin", "suspended")],
    ["an admin who is not yet active", () => makeOperator("admin", "pending")],
  ])("refuses %s, before GitHub is asked", async (_label, make) => {
    const lookup = vi.fn(known({ octocat: { id: "1" } }));
    expect(await addInvite(t.db, await make(), "octocat", lookup)).toEqual({ ok: false, error: "forbidden" });
    expect(lookup).not.toHaveBeenCalled();
    expect(await t.sql("select 1 from operator_invites")).toHaveLength(0);
  });

  it("reads the admin from the database, not from the object it was handed", async () => {
    const admin = await makeOperator();
    await t.db.update(operators).set({ role: "operator" }).where(eqId(admin.id));
    expect(await addInvite(t.db, { ...admin, role: "admin" }, "octocat", known({ octocat: { id: "1" } }))).toEqual({ ok: false, error: "forbidden" });
  });

  it.each(["", "a b", "-x", "../x", "q?x=1", "a".repeat(40)])("refuses the login %j before GitHub is asked", async (login) => {
    const admin = await makeOperator();
    const lookup = vi.fn(known({}));
    expect(await addInvite(t.db, admin, login, lookup)).toEqual({ ok: false, error: "invalid_login" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers github_not_found when GitHub does not know the login", async () => {
    const admin = await makeOperator();
    expect(await addInvite(t.db, admin, "nobody-here", known({}))).toEqual({ ok: false, error: "github_not_found" });
  });

  it("answers github_unavailable when GitHub cannot be reached, and invites nobody", async () => {
    const admin = await makeOperator();
    const down: GithubLookup = async () => {
      throw new GithubLookupError("unavailable");
    };
    expect(await addInvite(t.db, admin, "octocat", down)).toEqual({ ok: false, error: "github_unavailable" });
    const broken: GithubLookup = async () => {
      throw new Error("something else entirely");
    };
    expect(await addInvite(t.db, admin, "octocat", broken)).toEqual({ ok: false, error: "github_unavailable" });
    expect(await t.sql("select 1 from operator_invites")).toHaveLength(0);
  });

  it("stops at the limit, and still lets an existing invite be repeated", async () => {
    const admin = await makeOperator();
    await t.sql("reset role");
    await t.sql(`insert into operator_invites (github_id, github_login) select (1000 + g)::text, 'user' || g from generate_series(1, ${INVITES.max}) as g`);
    await t.sql("set role app_server");
    const result = await addInvite(t.db, admin, "newcomer", known({ newcomer: { id: "99999" } }));
    expect(result).toEqual({ ok: false, error: "invite_limit" });
    const repeat = await addInvite(t.db, admin, "user1", known({ user1: { id: "1001", login: "user1" } }));
    expect(repeat).toMatchObject({ ok: true, value: { added: false } });
  });
});

describe("removeInvite", () => {
  it("removes an invite and writes one audit row", async () => {
    const admin = await makeOperator();
    await addInvite(t.db, admin, "octocat", known({ octocat: { id: "583231" } }));
    expect(await removeInvite(t.db, admin, "583231")).toEqual({ ok: true, value: { removed: true } });
    expect(await isInvited(t.db, "583231")).toBe(false);
    const rows = await audit("invite.removed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: admin.id, target: "583231" });
    expect(rows[0].metadata).toEqual({ login: "octocat" });
  });

  it("says nothing was removed for an id that is not on the list, and writes nothing", async () => {
    const admin = await makeOperator();
    expect(await removeInvite(t.db, admin, "123")).toEqual({ ok: true, value: { removed: false } });
    expect(await audit("invite.removed")).toHaveLength(0);
  });

  it("does not touch an operator who is already active", async () => {
    const admin = await makeOperator();
    const person = await makeOperator("operator", "active");
    await t.sql("reset role");
    await t.sql("insert into operator_invites (github_id, github_login) values ($1, 'someone')", [person.githubId]);
    await t.sql("set role app_server");
    await removeInvite(t.db, admin, person.githubId);
    expect((await t.sql("select status from operators where id = $1", [person.id]))[0].status).toBe("active");
  });

  it.each(["", "abc", "12 3", "1; drop table x", "-5", "1".repeat(21)])("refuses the id %j", async (value) => {
    const admin = await makeOperator();
    expect(await removeInvite(t.db, admin, value)).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses someone who is not an active admin", async () => {
    const operator = await makeOperator("operator");
    expect(await removeInvite(t.db, operator, "123")).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("listInvites and isInvited", () => {
  it("lists newest first with the state of each person and who invited them", async () => {
    const admin = await makeOperator();
    const active = await makeOperator("operator", "active");
    const pending = await makeOperator("operator", "pending");
    const suspended = await makeOperator("operator", "suspended");
    const accounts: Record<string, { id: string }> = { a: { id: active.githubId }, p: { id: pending.githubId }, s: { id: suspended.githubId }, n: { id: "424242" } };
    for (const login of ["a", "p", "s", "n"]) await addInvite(t.db, admin, login, known(accounts));
    const list = await listInvites(t.db);
    expect(list.map((row) => row.githubLogin)).toEqual(["n", "s", "p", "a"]);
    expect(list.map((row) => row.state)).toEqual(["not_signed_in", "suspended", "pending", "active"]);
    expect(list.every((row) => row.invitedBy === "Operator")).toBe(true);
  });

  it("is empty when nobody has been invited", async () => {
    expect(await listInvites(t.db)).toEqual([]);
  });

  it("isInvited matches the id exactly", async () => {
    const admin = await makeOperator();
    await addInvite(t.db, admin, "octocat", known({ octocat: { id: "583231" } }));
    expect(await isInvited(t.db, "583231")).toBe(true);
    expect(await isInvited(t.db, "58323")).toBe(false);
    expect(await isInvited(t.db, "5832310")).toBe(false);
    expect(await isInvited(t.db, "octocat")).toBe(false);
  });
});

describe("the operator_invites table", () => {
  it("is read, added to and deleted from by the application role, never updated, and closed to everyone else", async () => {
    await expect(t.sql("update public.operator_invites set github_login = 'x'")).rejects.toMatchObject({ code: "42501" });
    await t.sql("reset role");
    try {
      await t.sql("set role nobody");
      await expect(t.sql("select * from public.operator_invites")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await t.sql("reset role");
      await t.sql("set role app_server");
    }
  });
});

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(operators.id, id);
}
