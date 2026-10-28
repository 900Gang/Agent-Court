import { describe, expect, it } from "vitest";
import { REPORT } from "@/lib/config/constants";
import { describeError } from "@/lib/dashboard/messages";
import { createGate } from "@/lib/safety/engine";
import { describeField } from "@/lib/safety/limits";

const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("the report limits", () => {
  it("are the agreed numbers", () => {
    expect(REPORT).toEqual({ minReason: 10, maxReason: 500, perOperatorPerDay: 10 });
  });
});

describe("the gate and the report target", () => {
  it("knows the reason field: 500 characters of prose", () => {
    expect(describeField("report", "reason")).toEqual({ limit: 500, kind: "prose" });
  });

  it.each([["title"], ["text"], ["description"], [""], ["reason.0"]])("does not know a field called %j", (name) => {
    expect(() => describeField("report", name)).toThrow("unknown gate field");
  });

  it("redacts a secret in a reason, and blocks a reason that is nothing but a secret", async () => {
    const gate = createGate();
    const prose = await gate.screen({ target: "report", fields: { reason: `This case printed ${awsKey} in its log and should come down.` } });
    expect(prose.outcome).toBe("pass");
    expect(prose.fields.reason).toContain("[REDACTED:aws_access_key]");
    expect(prose.fields.reason).not.toContain(awsKey);
    const dump = await gate.screen({ target: "report", fields: { reason: awsKey } });
    expect(dump.outcome).toBe("block");
  });

  it("blocks a reason over 500 characters", async () => {
    const result = await createGate().screen({ target: "report", fields: { reason: "a".repeat(501) } });
    expect(result.outcome).toBe("block");
  });
});

describe("the messages for the two new refusals", () => {
  it.each(["already_reported", "report_limit"])("%s has fixed text and a hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });

  it("states the daily limit in the text of report_limit", () => {
    expect(describeError("report_limit").message).toMatch(/10/);
  });
});
