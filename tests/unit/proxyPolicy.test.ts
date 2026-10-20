import { describe, expect, it } from "vitest";
import { decideProxyAction } from "@/lib/http/proxyPolicy";

const decide = (pathname: string, hasSessionCookie = false, killSwitch = false) =>
  decideProxyAction({ pathname, hasSessionCookie, killSwitch });

describe("kill switch", () => {
  it.each(["/api/v1", "/api/v1/me", "/api/v1/cases/123/arguments", "/mcp", "/mcp/messages"])(
    "stops agent traffic on %s",
    (path) => {
      expect(decide(path, false, true)).toBe("kill_switch");
      expect(decide(path, true, true)).toBe("kill_switch");
    },
  );

  it.each(["/api/v1", "/api/v1/me", "/mcp"])("lets %s through when the switch is off", (path) => {
    expect(decide(path, false, false)).toBe("next");
  });

  it.each(["/api/v10", "/api/v1x/me", "/api/v2/me", "/mcpx", "/mcp-docs", "/api/mcp"])(
    "does not mistake %s for agent traffic",
    (path) => {
      expect(decide(path, false, true)).toBe("next");
    },
  );

  it.each(["/api/auth/sign-in/social", "/api/auth/callback/github", "/api/cron/reminders", "/auth/login", "/"])(
    "leaves %s working while the switch is on, so operators can still sign in and clean up",
    (path) => {
      expect(decide(path, false, true)).toBe("next");
    },
  );

  it("does not change the dashboard rules", () => {
    expect(decide("/dashboard", false, true)).toBe("redirect_login");
    expect(decide("/dashboard", true, true)).toBe("next");
  });
});

describe("dashboard and admin protection", () => {
  it.each(["/dashboard", "/dashboard/agents", "/dashboard/agents/abc/keys", "/admin", "/admin/moderation"])(
    "sends %s to the login page without a session cookie",
    (path) => {
      expect(decide(path, false)).toBe("redirect_login");
    },
  );

  it.each(["/dashboard", "/dashboard/agents", "/admin", "/admin/moderation"])(
    "lets %s through with a session cookie",
    (path) => {
      expect(decide(path, true)).toBe("next");
    },
  );

  it.each(["/dashboardx", "/dashboards", "/administrator", "/admins", "/about", "/auth/login", "/"])(
    "does not protect %s",
    (path) => {
      expect(decide(path, false)).toBe("next");
    },
  );
});
