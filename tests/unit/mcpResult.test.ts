import { describe, expect, it } from "vitest";
import { internalRequest, toToolResult } from "@/lib/mcp/result";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SERVER_ERROR = {
  code: "server_error",
  message: "The court could not complete the request.",
  hint: "Try again later.",
};

describe("toToolResult: successes", () => {
  it.each([200, 201])("turns a %i body into text and structured content, and no error", async (status) => {
    const body = { notice: "n", case: { id: "c1", status: "open", untrusted_content: { title: "t" } } };
    const result = await toToolResult(json(status, body));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toStrictEqual(body);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(body) }]);
  });

  it("keeps a 202 held result a success and keeps its code and hint", async () => {
    const body = { notice: "n", case: { id: "c1", status: "held" }, code: "held_for_review", message: "m", hint: "h" };
    const result = await toToolResult(json(202, body));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toStrictEqual(body);
  });

  it("passes a very large body through whole", async () => {
    const body = { notice: "n", cases: Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, untrusted_content: { summary: "x".repeat(500) } })) };
    const result = await toToolResult(json(200, body));
    expect(result.structuredContent).toStrictEqual(body);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(1_000_000);
  });

  it("keeps the order of keys, so the text is exactly the body's JSON", async () => {
    const body = { z: 1, a: 2, m: { y: 1, b: 2 } };
    const result = await toToolResult(json(200, body));
    expect((result.content[0] as { text: string }).text).toBe('{"z":1,"a":2,"m":{"y":1,"b":2}}');
  });
});

describe("toToolResult: failures", () => {
  const catalog = { code: "x", message: "Fixed text.", hint: "Fixed hint." };

  it.each([400, 401, 403, 404, 409, 422, 503])("marks a %i response as an error and keeps its body", async (status) => {
    const result = await toToolResult(json(status, catalog));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual(catalog);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(catalog) }]);
  });

  it("adds the wait, as a number, to a 429", async () => {
    const result = await toToolResult(json(429, catalog, { "Retry-After": "42" }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({ ...catalog, retry_after_seconds: 42 });
    expect((result.content[0] as { text: string }).text).toBe(JSON.stringify({ ...catalog, retry_after_seconds: 42 }));
  });

  it.each([["missing", undefined], ["not a number", "soon"], ["negative", "-5"], ["fractional", "1.5"], ["empty", ""]])(
    "adds nothing to a 429 whose Retry-After is %s",
    async (_label, header) => {
      const result = await toToolResult(json(429, catalog, header === undefined ? {} : { "Retry-After": header }));
      expect(result.structuredContent).toStrictEqual(catalog);
    },
  );

  it("does not add a wait to any other status", async () => {
    const result = await toToolResult(json(503, catalog, { "Retry-After": "30" }));
    expect(result.structuredContent).toStrictEqual(catalog);
  });
});

describe("toToolResult: a response that is not a JSON object", () => {
  it.each([
    ["plain text", new Response("Not implemented", { status: 501 })],
    ["an empty body", new Response(null, { status: 204 })],
    ["an empty success body", new Response("", { status: 200 })],
    ["an array", json(200, [1, 2, 3])],
    ["null", json(200, null)],
    ["a string", json(200, "ok")],
    ["a number", json(200, 7)],
    ["broken JSON", new Response("{not json", { status: 200 })],
    ["HTML", new Response("<html><script>alert(1)</script></html>", { status: 500 })],
  ])("gives the fixed server error for %s", async (_label, response) => {
    const result = await toToolResult(response);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual(SERVER_ERROR);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(SERVER_ERROR) }]);
  });

  it("never lets the body of such a response into the result", async () => {
    const result = await toToolResult(new Response("secret-token-abc <script>", { status: 500 }));
    expect(JSON.stringify(result)).not.toContain("secret-token-abc");
  });
});

describe("internalRequest", () => {
  const auth = "Bearer ac_live_example_not_a_real_key";

  it("builds a request for the given path with the caller's own Authorization header", () => {
    const request = internalRequest({ method: "GET", path: "/api/v1/cases/abc", authorization: auth });
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/v1/cases/abc");
    expect(request.headers.get("authorization")).toBe(auth);
  });

  it("keeps the query string exactly", () => {
    const request = internalRequest({ method: "GET", path: "/api/v1/cases?status=open&needs_arguments=true&limit=5", authorization: auth });
    expect(new URL(request.url).search).toBe("?status=open&needs_arguments=true&limit=5");
  });

  it("sends a JSON body with its content type, and the idempotency key as a header", async () => {
    const body = { reasoning: "r", proposed_change: "p" };
    const request = internalRequest({ method: "POST", path: "/api/v1/cases/abc/arguments", authorization: auth, body, idempotencyKey: "retry-key-0001" });
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("idempotency-key")).toBe("retry-key-0001");
    expect(await request.json()).toEqual(body);
  });

  it("sends no idempotency header unless asked", () => {
    const request = internalRequest({ method: "POST", path: "/api/v1/cases", authorization: auth, body: {} });
    expect(request.headers.get("idempotency-key")).toBeNull();
  });

  it("carries no credential other than the Authorization header", () => {
    const request = internalRequest({ method: "POST", path: "/api/v1/cases", authorization: auth, body: { a: 1 }, idempotencyKey: "retry-key-0001" });
    const names = [...request.headers.keys()].sort();
    expect(names).toEqual(["authorization", "content-type", "idempotency-key"]);
  });

  it.each([
    ["another origin", "https://evil.example/api/v1/cases"],
    ["a protocol-relative address", "//evil.example/api/v1/cases"],
    ["another area of the app", "/admin/moderation"],
    ["the cron routes", "/api/cron/rescan"],
    ["a path that climbs out of the API", "/api/v1/../admin/moderation"],
    ["a path that does not start with a slash", "api/v1/cases"],
    ["an empty path", ""],
  ])("refuses %s", (_label, path) => {
    expect(() => internalRequest({ method: "GET", path, authorization: auth })).toThrow();
  });
});
