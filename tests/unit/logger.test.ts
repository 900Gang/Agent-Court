import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, scrub } from "@/lib/config/logger";

function capture(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "debug").mockImplementation(push);
  vi.spyOn(console, "info").mockImplementation(push);
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrub", () => {
  it("removes sensitive values by key, at any depth", () => {
    const result = JSON.stringify(
      scrub({
        authorization: "Bearer abc.def.ghi",
        nested: { password: "x-pass-123", list: [{ token: "t-123456" }] },
      }),
    );
    expect(result).not.toContain("abc.def.ghi");
    expect(result).not.toContain("x-pass-123");
    expect(result).not.toContain("t-123456");
  });

  it("matches keys case-insensitively and by common variants", () => {
    const result = JSON.stringify(
      scrub({
        Authorization: "secret-a",
        "Set-Cookie": "sid=secret-b",
        API_KEY: "secret-c",
        apiKey: "secret-d",
        accessToken: "secret-e",
        client_secret: "secret-f",
        body: '{"k":"secret-g"}',
        key: "secret-h",
      }),
    );
    for (const leaked of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(result).not.toContain(`secret-${leaked}`);
    }
  });

  it("leaves ordinary fields untouched", () => {
    expect(scrub({ route: "/api/v1/cases", status: 200, ok: true, note: null })).toEqual({
      route: "/api/v1/cases",
      status: 200,
      ok: true,
      note: null,
    });
  });

  it("redacts secret-shaped substrings inside string values", () => {
    const cases = [
      "Authorization: Bearer abc.def.ghi",
      "token=Bearer sk-live-123456",
      ["jwt", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjMifQ", "c2lnbmF0dXJl"].join("."), "end"].join(" "),
      "key ac_live_abcdefghijklmnop1234 end",
      "key ac_test_abcdefghijklmnop1234 end",
      "connect postgresql://user:hunter2pass@host.example/db failed",
    ];
    const leaks = [
      "abc.def.ghi",
      "sk-live-123456",
      "c2lnbmF0dXJl",
      "ac_live_abcdefghijklmnop1234",
      "ac_test_abcdefghijklmnop1234",
      "hunter2pass",
    ];
    cases.forEach((input, index) => {
      const output = String(scrub(input));
      expect(output).not.toContain(leaks[index]);
      expect(output).toContain("[REDACTED]");
    });
  });

  it("does not throw on circular structures", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => scrub(a)).not.toThrow();
  });

  it("logs an object that is referenced twice, and marks only true cycles as circular", () => {
    const shared = { route: "/x" };
    expect(scrub({ a: shared, b: shared })).toEqual({ a: { route: "/x" }, b: { route: "/x" } });
  });

  it("turns an Error into name and message only, with the message scrubbed", () => {
    const error = new Error("failed with Bearer abc.def.ghi");
    const result = scrub(error) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["message", "name"]);
    expect(result.name).toBe("Error");
    expect(String(result.message)).not.toContain("abc.def.ghi");
  });
});

describe("logger", () => {
  it("emits one JSON line with level, message, meta and time", () => {
    const lines = capture();
    logger.info("hello", { route: "/x" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: "info", message: "hello", meta: { route: "/x" } });
    expect(typeof entry.time).toBe("string");
  });

  it("supports debug, info, warn and error levels", () => {
    const lines = capture();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("never emits request bodies", () => {
    const lines = capture();
    logger.info("request", { body: '{"k":"v-secret"}' });
    expect(lines.join("\n")).not.toContain("v-secret");
  });

  it("scrubs the message itself", () => {
    const lines = capture();
    logger.warn("upstream said Bearer abc.def.ghi");
    expect(lines.join("\n")).not.toContain("abc.def.ghi");
  });

  it("never emits an Error stack", () => {
    const lines = capture();
    logger.error("boom", { err: new Error("x") });
    const output = lines.join("\n");
    expect(output).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
    expect(output).not.toContain("logger.test.ts");
  });

  it("does not throw on circular meta", () => {
    capture();
    const meta: Record<string, unknown> = { name: "m" };
    meta.self = meta;
    expect(() => logger.info("circular", meta)).not.toThrow();
  });
});