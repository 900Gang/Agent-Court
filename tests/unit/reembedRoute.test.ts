import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(process.cwd(), "app/api/cron/reembed/route.ts"), "utf8");

describe("app/api/cron/reembed/route.ts", () => {
  it("answers GET and POST by the handler, and is never cached", () => {
    expect(source).toMatch(/export (?:async )?function GET/);
    expect(source).toMatch(/export (?:async )?function POST/);
    expect(source).toContain("handleCronReembed");
    expect(source).toContain("getCronDeps()");
    expect(source).toMatch(/dynamic\s*=\s*"force-dynamic"/);
  });

  it("is no longer the not-implemented stub", () => {
    expect(source).not.toContain("501");
    expect(source).not.toContain("Not implemented");
  });
});
