import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { screenSafely, type GateTarget } from "@/lib/safety/gate";
import { failClosedGate } from "@/lib/safety/stub";
import { blockGate, brokenGate, passGate, throwingGate } from "../helpers/gates";

const fields = { title: "A title", summary: "A summary" };
const input = (target: GateTarget) => ({ target, fields });

describe("failClosedGate", () => {
  it.each(["case", "evidence", "argument"] as const)("flags %s content and leaves the text unchanged", async (target) => {
    const decision = await failClosedGate.screen(input(target));
    expect(decision.outcome).toBe("flag");
    expect(decision.fields).toEqual(fields);
    expect(decision.report).toEqual({ stub: true });
  });
});

describe("screenSafely", () => {
  it("passes a pass decision through", async () => {
    const decision = await screenSafely(passGate, input("case"));
    expect(decision.outcome).toBe("pass");
    expect(decision.fields).toEqual(fields);
  });

  it("passes a block decision through", async () => {
    expect((await screenSafely(blockGate, input("case"))).outcome).toBe("block");
  });

  it("flags when the gate throws, and keeps the error text out of the report", async () => {
    const decision = await screenSafely(throwingGate, input("argument"));
    expect(decision.outcome).toBe("flag");
    expect(decision.fields).toEqual(fields);
    expect(decision.report).toEqual({ error: "gate_failure" });
    expect(JSON.stringify(decision)).not.toContain("sk-live-secret");
  });

  it("flags when the gate returns an outcome the interface does not allow", async () => {
    const decision = await screenSafely(brokenGate, input("evidence"));
    expect(decision.outcome).toBe("flag");
    expect(decision.report).toEqual({ error: "gate_failure" });
  });

  it("flags when the gate returns something that is not a decision", async () => {
    const odd = { screen: async () => null as never };
    expect((await screenSafely(odd, input("case"))).outcome).toBe("flag");
  });
});

describe("test-only gates stay in tests", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it("is not imported or mentioned by app, lib or components", () => {
    const offenders = ["app", "lib", "components"]
      .flatMap((dir) => sourceFiles(path.join(root, dir)))
      .filter((file) => /tests\/helpers|helpers\/gates/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("screenSafely: returned fields", () => {
  it("flags a decision that drops a field it was given", async () => {
    const dropping = { screen: async () => ({ outcome: "pass" as const, fields: { title: "A title" }, report: {} }) };
    const decision = await screenSafely(dropping, input("case"));
    expect(decision.outcome).toBe("flag");
    expect(decision.fields).toEqual(fields);
    expect(decision.report).toEqual({ error: "gate_failure" });
  });
});

describe("screenSafely: logging", () => {
  it("logs the error class and the target, never the message or the field values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await screenSafely(throwingGate, input("case"));
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("gate failure");
      expect(line).toContain("Error");
      expect(line).toContain("case");
      expect(line).not.toContain("sk-live-secret");
      expect(line).not.toContain("A title");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a malformed decision as a failure too, and logs nothing for a good one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await screenSafely(brokenGate, input("evidence"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("InvalidDecision");
      warn.mockClear();
      await screenSafely(passGate, input("case"));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the fail-closed stub is for tests only", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it("is imported by no file under app, lib or components", () => {
    const offenders = ["app", "lib", "components"]
      .flatMap((dir) => sourceFiles(path.join(root, dir)))
      .filter((file) => !file.endsWith(`${path.sep}stub.ts`))
      .filter((file) => /safety\/stub/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
