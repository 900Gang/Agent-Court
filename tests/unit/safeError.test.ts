import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";
import { describeRequestError, safeErrorFields } from "@/lib/config/safeError";

// N10 Task 2 (AC-1003, AC-1004): what the request error hook may say about an error. A class name, Next.js's digest and
// the route pattern. Never the message, the stack, the cause, the path with its query, or any header.

// Assembled at run time: the repository is public and scanners flag whole tokens.
const SECRET = ["zq7vK2mX", "p9Lw4Tn8", "Bc3Yd6Rh"].join("");

class DatabaseTimeout extends Error {}

describe("safeErrorFields", () => {
  it("gives the class name and nothing from the message", () => {
    const fields = safeErrorFields(new Error(`could not connect, password ${SECRET}`));
    expect(fields).toEqual({ errorClass: "Error" });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it("gives the name of a subclass", () => {
    expect(safeErrorFields(new DatabaseTimeout("x")).errorClass).toBe("DatabaseTimeout");
    expect(safeErrorFields(new TypeError("x")).errorClass).toBe("TypeError");
  });

  it("ignores the stack and the cause", () => {
    const error = new Error("outer", { cause: new Error(SECRET) });
    error.stack = `Error: ${SECRET}\n    at somewhere`;
    expect(JSON.stringify(safeErrorFields(error))).not.toContain(SECRET);
  });

  it("keeps a digest that looks like one", () => {
    const error = Object.assign(new Error("x"), { digest: "1234567890" });
    expect(safeErrorFields(error)).toEqual({ errorClass: "Error", digest: "1234567890" });
  });

  it.each([
    ["a digest with spaces and punctuation", `see ${SECRET}!`],
    ["an empty digest", ""],
    ["a very long digest", "a".repeat(100)],
    ["a digest that is not a string", 12345],
    ["an object as digest", { secret: SECRET }],
  ])("drops %s", (_label, digest) => {
    const error = Object.assign(new Error("x"), { digest });
    expect(safeErrorFields(error)).toEqual({ errorClass: "Error" });
  });

  it.each([
    ["a string", `the token is ${SECRET}`],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an array", [SECRET]],
  ])("says NonError for %s and never repeats it", (_label, value) => {
    const fields = safeErrorFields(value);
    expect(fields.errorClass).toBe("NonError");
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it("takes the digest of a plain object that has one, and nothing else of it", () => {
    expect(safeErrorFields({ digest: "abc123", message: SECRET })).toEqual({ errorClass: "NonError", digest: "abc123" });
  });

  it("refuses a class name that is not a plain identifier", () => {
    const odd = new Error("x");
    Object.defineProperty(odd, "constructor", { value: { name: `Evil ${SECRET}` } });
    expect(JSON.stringify(safeErrorFields(odd))).not.toContain(SECRET);
  });

  it("never throws, whatever it is given", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("boom"); } });
    expect(() => safeErrorFields(hostile)).not.toThrow();
  });
});

const request = (over: Record<string, unknown> = {}) => ({
  path: `/api/v1/cases?token=${SECRET}`,
  method: "POST",
  headers: { authorization: `Bearer ${SECRET}`, cookie: `session=${SECRET}`, "x-anything": SECRET },
  ...over,
});
const context = (over: Record<string, unknown> = {}) => ({
  routerKind: "App Router",
  routePath: "/app/api/v1/cases/[id]/route",
  routeType: "route",
  renderSource: undefined,
  revalidateReason: undefined,
  renderType: "dynamic",
  ...over,
});

describe("describeRequestError", () => {
  it("names the class, the method, the route pattern and the route type", () => {
    expect(describeRequestError(new TypeError("x"), request(), context())).toEqual({
      errorClass: "TypeError",
      method: "POST",
      route: "/app/api/v1/cases/[id]/route",
      routeType: "route",
    });
  });

  it("holds nothing from the message, the path, the query or the headers", () => {
    const text = JSON.stringify(describeRequestError(new Error(SECRET), request(), context()));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("cookie");
    expect(text).not.toContain("token=");
  });

  it("includes the render source and the digest when there are some", () => {
    const error = Object.assign(new Error("x"), { digest: "d1g3st" });
    const fields = describeRequestError(error, request(), context({ renderSource: "react-server-components" }));
    expect(fields).toMatchObject({ renderSource: "react-server-components", digest: "d1g3st" });
  });

  it.each([
    ["a route path with a query string", "/app/x?token=" + SECRET],
    ["a route path with spaces", `/app/${SECRET} x`],
    ["a route path that is far too long", "/" + "a".repeat(300)],
    ["a route path that is not a string", { secret: SECRET }],
  ])("replaces %s with a fixed word", (_label, routePath) => {
    const fields = describeRequestError(new Error("x"), request(), context({ routePath }));
    expect(fields.route).toBe("[unknown]");
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it.each([
    ["a method with odd characters", `P0ST ${SECRET}`],
    ["a lower case method", "post"],
    ["a method that is not a string", 7],
  ])("replaces %s with OTHER", (_label, method) => {
    const fields = describeRequestError(new Error("x"), request({ method }), context());
    expect(fields.method).toBe("OTHER");
  });

  it("replaces a route type or render source it does not know", () => {
    const fields = describeRequestError(new Error("x"), request(), context({ routeType: SECRET, renderSource: SECRET }));
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it("never throws when the request or the context is missing or odd", () => {
    expect(() => describeRequestError(new Error("x"), undefined, undefined)).not.toThrow();
    expect(() => describeRequestError(new Error("x"), null, 5)).not.toThrow();
  });
});

describe("onRequestError", () => {
  const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) => ({ level, spy: vi.spyOn(console, level) }));
  beforeEach(() => spies.forEach(({ spy }) => spy.mockImplementation(() => undefined)));
  afterEach(() => spies.forEach(({ spy }) => spy.mockClear()));

  const output = () => spies.flatMap(({ spy }) => spy.mock.calls.flat()).join("\n");

  it("writes one error line with the safe fields", async () => {
    await onRequestError(new DatabaseTimeout(SECRET), request(), context());
    const lines = spies.flatMap(({ level, spy }) => spy.mock.calls.map((call) => ({ level, text: String(call[0]) })));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("error");
    const entry = JSON.parse(lines[0].text);
    expect(entry.message).toBe("request error");
    expect(entry.meta).toMatchObject({ errorClass: "DatabaseTimeout", method: "POST", route: "/app/api/v1/cases/[id]/route", routeType: "route" });
  });

  it("leaves every piece of the secret out of the line, whatever carried it", async () => {
    await onRequestError(new Error(`failed for ${SECRET}`), request(), context());
    const text = output();
    for (let start = 0; start + 8 <= SECRET.length; start += 1) {
      expect(text).not.toContain(SECRET.slice(start, start + 8));
    }
  });

  it("does not throw, and writes a fixed line, when it is given nonsense", async () => {
    await expect(onRequestError(undefined, undefined as never, undefined as never)).resolves.toBeUndefined();
    expect(output()).toContain("request error");
  });
});
