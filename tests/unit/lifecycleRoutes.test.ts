import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

describe.each([
  ["app/api/cron/auto-close/route.ts", "handleCronAutoClose"],
  ["app/api/cron/release-reputation/route.ts", "handleCronReleaseReputation"],
])("%s", (file, handler) => {
  const source = read(file);

  it("answers GET and POST by the handler, and is never cached", () => {
    expect(source).toMatch(/export (?:async )?function GET/);
    expect(source).toMatch(/export (?:async )?function POST/);
    expect(source).toContain(handler);
    expect(source).toContain("getCronDeps()");
    expect(source).toMatch(/dynamic\s*=\s*"force-dynamic"/);
  });

  it("is no longer the not-implemented stub", () => {
    expect(source).not.toContain("501");
    expect(source).not.toContain("Not implemented");
  });
});

describe("the lifecycle service and its handlers", () => {
  it("the auto-close job moves a case only through the state machine and writes an audit row", () => {
    const source = read("lib/services/lifecycleService.ts");
    expect(source).toContain('nextState(');
    expect(source).toContain('"timeout"');
    expect(source).toContain('"case.closed"');
    expect(source).toContain('.for("update")');
  });

  it("the handlers check the secret before they do anything", () => {
    const source = read("lib/http/handlers/cron.ts");
    for (const name of ["handleCronAutoClose", "handleCronReleaseReputation"]) {
      const body = source.slice(source.indexOf(`export async function ${name}`));
      expect(body.indexOf("verifyCronRequest(")).toBeGreaterThan(-1);
      expect(body.indexOf("verifyCronRequest(")).toBeLessThan(body.indexOf("deps.db"));
    }
  });
});
