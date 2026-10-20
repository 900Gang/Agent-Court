import { describe, expect, it } from "vitest";
import { ERROR_CODES, errorResponse, statusFor, type ErrorCode } from "@/lib/http/errors";

const expectedStatus: Record<ErrorCode, number> = {
  missing_key: 401,
  invalid_key: 401,
  revoked_key: 401,
  expired_key: 401,
  agent_inactive: 403,
  operator_inactive: 403,
  forbidden_scope: 403,
  rate_limited: 429,
  kill_switch: 503,
};

describe("error codes", () => {
  it("defines exactly the nine agreed codes", () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expectedStatus).sort());
  });

  it.each(Object.entries(expectedStatus))("maps %s to HTTP %i", (code, status) => {
    expect(statusFor(code as ErrorCode)).toBe(status);
  });
});

describe("errorResponse", () => {
  it.each(Object.entries(expectedStatus))("builds a JSON response for %s", async (code, status) => {
    const response = errorResponse(code as ErrorCode);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["code", "hint", "message"]);
    expect(body.code).toBe(code);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(typeof body.hint).toBe("string");
    expect(body.hint.length).toBeGreaterThan(0);
  });

  it("is the same every time, so a hint can never carry input", async () => {
    const first = await errorResponse("invalid_key").text();
    const second = await errorResponse("invalid_key").text();
    expect(first).toBe(second);
  });

  it.each(["missing_key", "invalid_key", "revoked_key", "expired_key"] as const)(
    "tells the client how to authenticate on %s",
    (code) => {
      expect(errorResponse(code).headers.get("www-authenticate")).toBe("Bearer");
    },
  );

  it.each(["agent_inactive", "operator_inactive", "forbidden_scope", "rate_limited", "kill_switch"] as const)(
    "does not send WWW-Authenticate for %s",
    (code) => {
      expect(errorResponse(code).headers.get("www-authenticate")).toBeNull();
    },
  );

  it("adds extra headers, such as the rate-limit headers", () => {
    const response = errorResponse("rate_limited", { "Retry-After": "42", "RateLimit-Limit": "60" });
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("ratelimit-limit")).toBe("60");
  });

  it("does not let extra headers replace the content type or caching rules", () => {
    const response = errorResponse("rate_limited", { "Content-Type": "text/html", "Cache-Control": "public" });
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives actionable hints", async () => {
    const hint = async (code: ErrorCode) => (await errorResponse(code).json()).hint as string;
    expect(await hint("rate_limited")).toMatch(/Retry-After/);
    expect(await hint("revoked_key")).toMatch(/new key/i);
    expect(await hint("expired_key")).toMatch(/new key/i);
    expect(await hint("missing_key")).toMatch(/Authorization/);
    expect(await hint("forbidden_scope")).toMatch(/scope/i);
    expect(await hint("kill_switch")).toMatch(/later|retry/i);
  });
});
