import { describe, expect, it } from "vitest";
import { parseIdempotencyKey } from "@/lib/schemas/idempotency";
import { decodeCursor, encodeCursor, parseListQuery } from "@/lib/schemas/pagination";

const id = "0b8f4c1e-5d2a-4b7e-9c3d-1a2b3c4d5e6f";
const createdAt = new Date("2026-10-20T12:00:00.123Z");
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const query = (qs: string) => parseListQuery(new URLSearchParams(qs));

function detailOf(result: { ok: boolean; detail?: Record<string, string> }): Record<string, string> {
  if (result.ok) throw new Error("expected a failure");
  return result.detail ?? {};
}

describe("cursor", () => {
  it("round-trips a timestamp and id", () => {
    const decoded = decodeCursor(encodeCursor({ createdAt, id }));
    expect(decoded?.id).toBe(id);
    expect(decoded?.createdAt.toISOString()).toBe("2026-10-20T12:00:00.123Z");
  });

  it("is opaque base64url text", () => {
    expect(encodeCursor({ createdAt, id })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes the documented format {t, i}", () => {
    expect(decodeCursor(b64({ t: "2026-10-20T12:00:00.123Z", i: id }))?.id).toBe(id);
  });

  it.each([
    ["not base64url", "!!"],
    ["an empty object", b64({})],
    ["not JSON", b64("hello")],
    ["a non-date t", b64({ t: "nope", i: id })],
    ["a date-only t", b64({ t: "2026-10-20", i: id })],
    ["a non-UUID id", b64({ t: "2026-10-20T12:00:00.123Z", i: "x" })],
    ["extra types", b64({ t: 5, i: id })],
    ["an array", b64([1, 2])],
    ["empty", ""],
    ["very long", "a".repeat(10000)],
  ])("returns null for %s", (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe("parseListQuery", () => {
  it("applies defaults", () => {
    expect(query("")).toEqual({
      ok: true,
      value: { limit: 20, cursor: null, status: null, tag: null, needsArguments: false },
    });
  });

  it.each([["1", 1], ["20", 20], ["50", 50]])("accepts limit=%s", (raw, limit) => {
    const result = query(`limit=${raw}`);
    expect(result.ok && result.value.limit).toBe(limit);
  });

  it.each(["0", "-1", "51", "1000", "1.5", "abc", "", "1e1", " 5"])("rejects limit=%j", (raw) => {
    const params = new URLSearchParams();
    params.set("limit", raw);
    expect(detailOf(parseListQuery(params))).toHaveProperty("limit");
  });

  it("accepts a valid cursor and rejects a bad one", () => {
    const cursor = encodeCursor({ createdAt, id });
    const good = query(`cursor=${cursor}`);
    expect(good.ok && good.value.cursor?.id).toBe(id);
    expect(detailOf(query("cursor=!!"))).toHaveProperty("cursor");
    expect(detailOf(query(`cursor=${b64({})}`))).toHaveProperty("cursor");
  });

  it.each(["open", "argued", "resolved", "under_appeal", "closed_unresolved"])("accepts status=%s", (status) => {
    const result = query(`status=${status}`);
    expect(result.ok && result.value.status).toBe(status);
  });

  it.each(["held", "withdrawn", "rejected", "bogus", ""])("rejects status=%j", (status) => {
    const params = new URLSearchParams();
    params.set("status", status);
    expect(detailOf(parseListQuery(params))).toHaveProperty("status");
  });

  it("accepts a slug tag and rejects anything else", () => {
    const result = query("tag=tool-call");
    expect(result.ok && result.value.tag).toBe("tool-call");
    const bad = new URLSearchParams();
    bad.set("tag", "Bad Tag");
    expect(detailOf(parseListQuery(bad))).toHaveProperty("tag");
  });

  it("reads needs_arguments as true or false only", () => {
    const yes = query("needs_arguments=true");
    const no = query("needs_arguments=false");
    expect(yes.ok && yes.value.needsArguments).toBe(true);
    expect(no.ok && no.value.needsArguments).toBe(false);
    expect(detailOf(query("needs_arguments=yes"))).toHaveProperty("needs_arguments");
  });

  it("ignores query parameters it does not know", () => {
    expect(query("foo=bar&utm_source=x").ok).toBe(true);
  });
});

describe("parseIdempotencyKey", () => {
  it("treats a missing header as no key", () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, value: null });
  });

  it.each(["abcdefgh", "a".repeat(128), "req_2026-10-20:retry.1"])("accepts %s", (key) => {
    expect(parseIdempotencyKey(key)).toEqual({ ok: true, value: key });
  });

  it.each(["short", "a".repeat(129), "has space here", "semi;colon!", "", "new\nline123"])("rejects %j", (key) => {
    expect(parseIdempotencyKey(key).ok).toBe(false);
  });
});
