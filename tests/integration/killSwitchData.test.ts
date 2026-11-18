import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, operators } from "@/db/schema";
import { loadKillSwitchViewFrom } from "@/lib/admin/killSwitchData";
import { setKillSwitch } from "@/lib/services/killSwitchService";
import { createTestDb, type TestDb } from "../helpers/db";
import { createFixtures } from "../helpers/fixtures";

// N10 Task 1 (AC-1007): what the /admin/kill-switch page reads.

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

describe("loadKillSwitchViewFrom", () => {
  it("starts off, with no agents", async () => {
    expect(await loadKillSwitchViewFrom(t.db, false)).toEqual({ on: false, envOn: false, agents: [], truncated: false });
  });

  it("passes the environment value through without mixing it into the database value", async () => {
    const view = await loadKillSwitchViewFrom(t.db, true);
    expect(view.envOn).toBe(true);
    expect(view.on).toBe(false);
  });

  it("shows the database value after an admin turns the switch on", async () => {
    const [admin] = await t.db
      .insert(operators)
      .values({ githubId: f.uniq("gh"), displayName: "Admin", role: "admin", status: "active" })
      .returning();
    await setKillSwitch(t.db, admin, true, "Testing the page that reads it");
    expect((await loadKillSwitchViewFrom(t.db, false)).on).toBe(true);
  });

  it("lists agents with their operator's name and status, newest first, and leaves out deleted ones", async () => {
    const first = await f.makeAgent();
    const second = await f.makeAgent();
    const gone = await f.makeAgent();
    await t.db.update(agents).set({ status: "suspended" }).where(eq(agents.id, first.agent.id));
    await t.db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.agent.id));
    const view = await loadKillSwitchViewFrom(t.db, false);
    const handles = view.agents.map((row) => row.handle);
    expect(handles).toContain(first.agent.handle);
    expect(handles).toContain(second.agent.handle);
    expect(handles).not.toContain(gone.agent.handle);
    expect(handles.indexOf(second.agent.handle)).toBeLessThan(handles.indexOf(first.agent.handle));
    const row = view.agents.find((entry) => entry.agentId === first.agent.id);
    expect(row).toEqual({ agentId: first.agent.id, handle: first.agent.handle, operatorName: "Operator", status: "suspended" });
    expect(view.truncated).toBe(false);
  });

  it("lists at most 100 agents and says when there are more", async () => {
    const [operator] = await t.db.select().from(operators).limit(1);
    const rows = Array.from({ length: 101 }, (_unused, index) => ({ operatorId: operator.id, handle: `bulk-agent-${index + 100}` }));
    await t.db.insert(agents).values(rows);
    const view = await loadKillSwitchViewFrom(t.db, false);
    expect(view.agents).toHaveLength(100);
    expect(view.truncated).toBe(true);
  });
});
