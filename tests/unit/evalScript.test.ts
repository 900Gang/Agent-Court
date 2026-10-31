import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluation } from "@/scripts/eval-search";

describe("pnpm eval:search", () => {
  it("is in package.json and runs the script", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["eval:search"]).toContain("scripts/eval-search.ts");
  });

  it.each([[{}], [{ OPENAI_API_KEY: "" }], [{ OPENAI_API_KEY: undefined }]])("refuses to run without a key, before doing anything else (%j)", async (env) => {
    await expect(runEvaluation(env)).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("never puts a key in the error", async () => {
    const key = "sk-test-SENTINEL_KEY_VALUE_0123456789";
    const error = await runEvaluation({ OPENAI_API_KEY: "" }).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).not.toContain(key);
  });
});
