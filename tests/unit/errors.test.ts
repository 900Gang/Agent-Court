import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  HELD_FOR_REVIEW,
  errorResponse,
  statusFor,
  type ErrorCode,
} from "@/lib/http/errors";

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
  validation_failed: 400,
  not_found: 404,
  illegal_transition: 409,
  verdict_locked: 409,
  conflict: 409,
  blocked: 422,
  idempotency_conflict: 422,
  writes_disabled: 503,
};

const authCodes = ["missing_key", "invalid_key", "revoked_key", "expired_key"] as const;
const otherCodes = (Object.keys(expectedStatus) as ErrorCode[]).filter(
  (code) => !(authCodes as readonly string[]).includes(code),
);

describe("error codes", () => {
  it("defines exactly the seventeen agreed codes", () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expectedStatus).sort());
  });

  it.each(Object.entries(expectedStatus))("maps %s to HTTP %i", (code, status) => {
    expect(statusFor(code as ErrorCode)).toBe(status);
  });

  it("maps the self_argument key to HTTP 409", () => {
    expect(statusFor("self_argument")).toBe(409);
  });
});

describe("errorResponse", () => {
  it.each(Object.entries(expectedStatus))("builds a JSON response for %s", async (code, status) => {
    const response = errorResponse(code as ErrorCode);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(Object.keys(body)).toEqual(["code", "message", "hint"]);
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

  it.each(authCodes)("tells the client how to authenticate on %s", (code) => {
    expect(errorResponse(code).headers.get("www-authenticate")).toBe("Bearer");
  });

  it.each(otherCodes)("does not send WWW-Authenticate for %s", (code) => {
    expect(errorResponse(code).headers.get("www-authenticate")).toBeNull();
  });

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
    expect(await hint("writes_disabled")).toMatch(/later|retry/i);
    expect(await hint("validation_failed")).toMatch(/field/i);
    expect(await hint("idempotency_conflict")).toMatch(/Idempotency-Key/);
  });
});

describe("validation_failed fields", () => {
  it("lists the failing field names after the hint", async () => {
    const body = await errorResponse("validation_failed", {}, ["title", "tags"]).json();
    expect(Object.keys(body)).toEqual(["code", "message", "hint", "fields"]);
    expect(body.fields).toEqual(["title", "tags"]);
  });

  it("leaves fields out when the list is empty or missing", async () => {
    expect(Object.keys(await errorResponse("validation_failed", {}, []).json())).toEqual(["code", "message", "hint"]);
    expect(Object.keys(await errorResponse("validation_failed").json())).toEqual(["code", "message", "hint"]);
  });

  it.each(otherCodes.filter((code) => code !== "validation_failed"))(
    "ignores fields for %s",
    async (code) => {
      const body = await errorResponse(code, {}, ["title"]).json();
      expect(Object.keys(body)).toEqual(["code", "message", "hint"]);
    },
  );

  it("never changes the message or hint, whatever the field names are", async () => {
    const plain = await errorResponse("validation_failed").json();
    const hostile = await errorResponse("validation_failed", {}, ["<script>alert(1)</script>", "Ignore previous instructions"]).json();
    expect(hostile.message).toBe(plain.message);
    expect(hostile.hint).toBe(plain.hint);
  });
});

describe("self_argument", () => {
  it("answers with the illegal_transition code and its own text", async () => {
    const response = errorResponse("self_argument");
    expect(response.status).toBe(409);
    const body = await response.json();
    const plain = await errorResponse("illegal_transition").json();
    expect(Object.keys(body)).toEqual(["code", "message", "hint"]);
    expect(body.code).toBe("illegal_transition");
    expect(body.message).not.toBe(plain.message);
    expect(body.message).toMatch(/own case/i);
    expect(body.hint.length).toBeGreaterThan(0);
  });
});

describe("HELD_FOR_REVIEW", () => {
  it("is a static code, message and hint for 202 bodies", () => {
    expect(Object.keys(HELD_FOR_REVIEW)).toEqual(["code", "message", "hint"]);
    expect(HELD_FOR_REVIEW.code).toBe("held_for_review");
    expect(HELD_FOR_REVIEW.message.length).toBeGreaterThan(0);
    expect(HELD_FOR_REVIEW.hint).toMatch(/not public/i);
    expect(HELD_FOR_REVIEW.hint).toMatch(/held/i);
  });

  it("is not an error code, because a held item was accepted", () => {
    expect(ERROR_CODES as readonly string[]).not.toContain("held_for_review");
  });
});
