import { describe, expect, it } from "vitest";
import { prepareQuery } from "@/lib/search/query";

const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const github = ["ghp", "_", "ZxQ9mN2vB8wR5tY1cH4jD6sF0aG3kL7pT2uX"].join("");

describe("prepareQuery", () => {
  it("leaves an ordinary query as it is", () => {
    expect(prepareQuery("agent retries after a 429")).toEqual({ text: "agent retries after a 429", redactions: 0, searchable: true });
  });

  it("replaces a secret with a placeholder and counts it, and the secret is gone", () => {
    const result = prepareQuery(`error with key ${aws} in the header`);
    expect(result.text).toContain("[REDACTED:aws_access_key]");
    expect(result.text).not.toContain(aws);
    expect(result.redactions).toBe(1);
    expect(result.searchable).toBe(true);
  });

  it("counts every secret in the query", () => {
    const result = prepareQuery(`${aws} and ${github} leaked`);
    expect(result.redactions).toBe(2);
    expect(result.text).not.toContain(aws);
    expect(result.text).not.toContain(github);
  });

  it("removes control and hidden characters, and trims", () => {
    expect(prepareQuery("  retry\u0000 loop\u200b  ").text).toBe("retry loop");
  });

  it("says a query of nothing but a secret, or nothing at all, is not worth searching", () => {
    expect(prepareQuery(aws).searchable).toBe(false);
    expect(prepareQuery(`${aws} ${github}`).searchable).toBe(false);
    expect(prepareQuery("").searchable).toBe(false);
    expect(prepareQuery("   ").searchable).toBe(false);
    expect(prepareQuery("\u0000\u0007").searchable).toBe(false);
  });

  it("never returns more than 200 characters", () => {
    expect(prepareQuery("word ".repeat(100)).text.length).toBeLessThanOrEqual(200);
    expect(prepareQuery(`${"x ".repeat(95)}${aws}`).text.length).toBeLessThanOrEqual(200);
  });

  it("is stable: preparing a prepared query changes nothing", () => {
    const once = prepareQuery(`error with key ${aws} in the header`);
    expect(prepareQuery(once.text).text).toBe(once.text);
  });
});
