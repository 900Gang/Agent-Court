import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// N10 Task 1 (AC-1007): proxy.ts asks the runtime reader (database flag plus environment override) instead of reading
// the environment itself. The rules about which paths are stopped stay in lib/http/proxyPolicy.ts and its own tests.
vi.mock("@/lib/http/killSwitchRuntime", () => ({ isKillSwitchOn: vi.fn() }));

import { isKillSwitchOn } from "@/lib/http/killSwitchRuntime";
import { proxy } from "@/proxy";

const on = vi.mocked(isKillSwitchOn);
const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);
const SESSION = "better-auth.session_token=abc";
const passesThrough = (response: Response) => response.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  on.mockReset();
});

describe("proxy with the switch on", () => {
  beforeEach(() => on.mockResolvedValue(true));

  it.each(["/api/v1/me", "/api/v1/cases", "/mcp"])("answers agent traffic on %s with the fixed 503", async (path) => {
    const response = await proxy(request(path));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("kill_switch");
  });

  it.each([
    ["/dashboard", SESSION],
    ["/admin", SESSION],
    ["/admin/kill-switch", SESSION],
    ["/", undefined],
    ["/auth/login", undefined],
  ])("still serves %s", async (path, cookie) => {
    const response = await proxy(request(path, cookie));
    expect(passesThrough(response)).toBe(true);
  });

  it("still sends an anonymous visitor to the login page", async () => {
    const response = await proxy(request("/admin"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/auth/login");
  });
});

describe("proxy with the switch off", () => {
  beforeEach(() => on.mockResolvedValue(false));

  it.each(["/api/v1/me", "/mcp"])("lets %s through", async (path) => {
    expect(passesThrough(await proxy(request(path)))).toBe(true);
  });
});

describe("proxy and the runtime reader", () => {
  it("asks the reader on every request, since the reader does the caching", async () => {
    on.mockResolvedValue(false);
    await proxy(request("/api/v1/me"));
    await proxy(request("/api/v1/me"));
    expect(on).toHaveBeenCalledTimes(2);
  });
});
