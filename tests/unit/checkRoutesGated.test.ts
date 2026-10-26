import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXEMPT, findViolations, formatReport, listWriteRoutes } from "@/scripts/check-routes-gated";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WRITE_HANDLER = `export function handleFileCase(request: Request, deps: unknown) {
  return runApi(request, deps, { scope: "cases:write", write: true }, async () => ok());
}
`;
const READ_HANDLER = `export function handleListCases(request: Request, deps: unknown) {
  return runApi(request, deps, { scope: "read", write: false }, async () => ok());
}
`;
const POST_ROUTE = (handler: string) => `import { ${handler} } from "@/lib/http/handlers/cases";
export async function POST(request: Request) {
  return ${handler}(request, getApiDeps());
}
`;
const SERVICE = (body: string, screens: boolean) =>
  `${screens ? 'import { screenSafely } from "@/lib/safety/gate";\n' : ""}export async function save(db: unknown) {
  ${body}
}
`;

/** A small valid repository, plus or minus the files a test passes in (null removes one). */
const BASE: Record<string, string> = {
  "app/api/v1/cases/route.ts": POST_ROUTE("handleFileCase"),
  "lib/http/handlers/cases.ts": WRITE_HANDLER + READ_HANDLER,
  "lib/services/caseService.ts": SERVICE("await db.insert(cases).values({});", true),
  "lib/safety/stub.ts": "export const failClosedGate = {};\n",
};

function tree(files: Record<string, string | null> = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "gated-"));
  roots.push(root);
  for (const [relative, content] of Object.entries({ ...BASE, ...files })) {
    if (content === null) continue;
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const MARKER = "PLANTED_CONTENT_MARKER_123";

describe("findViolations: the real repository", () => {
  it("finds none", () => {
    expect(findViolations(repo)).toEqual([]);
  });

  it("really inspects the write routes, so an empty result is not an accident", () => {
    const routes = listWriteRoutes(repo);
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes).toContainEqual({ file: "app/api/v1/cases/route.ts", methods: ["POST"], handlers: ["handleFileCase"] });
    expect(routes.map((route) => route.file)).not.toContain("app/api/cron/rescan/route.ts");
    expect(routes.map((route) => route.file)).not.toContain("app/api/auth/[...all]/route.ts");
  });
});

describe("findViolations: write routes", () => {
  it("accepts a valid tree", () => {
    expect(findViolations(tree())).toEqual([]);
  });

  it("reports a POST route whose handler does not run as a write", () => {
    const root = tree({ "app/api/v1/cases/route.ts": POST_ROUTE("handleListCases") });
    const violations = findViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^app\/api\/v1\/cases\/route\.ts: /);
  });

  it("reports a POST route whose handler never calls runApi", () => {
    const root = tree({
      "lib/http/handlers/cases.ts": `export function handleFileCase(request: Request) { return new Response("ok"); }\n`,
    });
    expect(findViolations(root)).toHaveLength(1);
  });

  it("reports a POST route that calls no handler", () => {
    const root = tree({ "app/api/v1/cases/route.ts": `export async function POST() { return new Response("ok"); }\n` });
    expect(findViolations(root)).toHaveLength(1);
  });

  it("reports a POST route whose handler cannot be found", () => {
    const root = tree({ "lib/http/handlers/cases.ts": READ_HANDLER });
    expect(findViolations(root)).toHaveLength(1);
  });

  it.each(["PUT", "PATCH", "DELETE"])("holds a %s route to the same rule", (method) => {
    const route = `export async function ${method}(request: Request) { return handleListCases(request, getApiDeps()); }\n`;
    const violations = findViolations(tree({ "app/api/v1/cases/route.ts": route }));
    expect(violations).toHaveLength(1);
  });

  it("reports a write method exported in a form it cannot read, rather than skipping it", () => {
    const root = tree({ "app/api/v1/cases/route.ts": `export const POST = handleFileCase;\n` });
    expect(findViolations(root)).toHaveLength(1);
  });

  it("does not look at read-only routes", () => {
    const root = tree({
      "app/api/v1/cases/search/route.ts": `export function GET() { return new Response("Not implemented", { status: 501 }); }\n`,
    });
    expect(findViolations(root)).toEqual([]);
  });

  it("leaves the auth and cron routes alone, which have their own protection", () => {
    const root = tree({
      "app/api/auth/[...all]/route.ts": `export const { GET, POST } = toNextJsHandler(handler);\n`,
      "app/api/cron/rescan/route.ts": `export function POST(request: Request) { return handleCronRescan(request, getCronDeps()); }\n`,
    });
    expect(findViolations(root)).toEqual([]);
  });

  it("also covers routes outside app/api", () => {
    const root = tree({ "app/mcp/route.ts": `export async function POST() { return new Response("ok"); }\n` });
    expect(findViolations(root)).toHaveLength(1);
  });
});

describe("findViolations: services that store agent text", () => {
  it.each([
    ["cases", "await db.insert(cases).values({});"],
    ["evidence", "await tx.insert(evidence).values({});"],
    ["arguments", "await tx.insert(argumentsTable).values({});"],
    ["agents", "await tx.insert(agents).values({});"],
    ["raw SQL", 'await db.execute("insert into evidence (id) values (1)");'],
    ["a multi-line call", "await db\n    .insert(\n      cases,\n    )\n    .values({});"],
  ])("reports an insert into %s without a screenSafely import", (_label, body) => {
    const violations = findViolations(tree({ "lib/services/otherService.ts": SERVICE(body, false) }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^lib\/services\/otherService\.ts: /);
  });

  it("accepts the same insert once the file imports screenSafely", () => {
    const root = tree({ "lib/services/otherService.ts": SERVICE("await db.insert(cases).values({});", true) });
    expect(findViolations(root)).toEqual([]);
  });

  it("does not mind inserts into tables that hold no agent text", () => {
    const body = "await db.insert(auditLog).values({});\n  await db.insert(moderationEvents).values({});\n  await db.insert(apiKeys).values({});";
    expect(findViolations(tree({ "lib/services/auditService.ts": SERVICE(body, false) }))).toEqual([]);
  });

  it("does not mind a service that only reads", () => {
    const body = "return db.select().from(cases);";
    expect(findViolations(tree({ "lib/services/readService.ts": SERVICE(body, false) }))).toEqual([]);
  });
});

describe("findViolations: the fail-closed stub", () => {
  it.each(["lib/http/apiPipeline.ts", "app/api/v1/x/route.ts", "components/Thing.tsx", "lib/services/x.ts"])(
    "reports %s when it mentions failClosedGate",
    (file) => {
      const violations = findViolations(
        tree({ [file]: `import { failClosedGate } from "@/lib/safety/stub";\nexport const gate = failClosedGate;\n` }),
      );
      expect(violations.some((message) => message.startsWith(`${file}: `))).toBe(true);
    },
  );

  it("allows the stub file itself, and tests", () => {
    const root = tree({ "tests/helpers/gates.ts": `import { failClosedGate } from "@/lib/safety/stub";\n` });
    expect(findViolations(root)).toEqual([]);
  });
});

describe("findViolations: exemptions and messages", () => {
  it("exempts the seed file and scripts", () => {
    const root = tree({
      "db/seed.ts": SERVICE("await db.insert(cases).values({});", false),
      "scripts/import.ts": SERVICE("await db.insert(agents).values({});", false),
    });
    expect(findViolations(root)).toEqual([]);
    expect(EXEMPT.map((entry) => entry.path)).toEqual(["db/seed.ts", "scripts/"]);
    for (const entry of EXEMPT) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it("is quiet about a repository with none of these directories", () => {
    expect(findViolations(tree({ "app/api/v1/cases/route.ts": null, "lib/http/handlers/cases.ts": null }))).toEqual([]);
  });

  it("names files and rules only, never content, and always with forward slashes", () => {
    const root = tree({
      "app/api/v1/cases/route.ts": `// ${MARKER}\n${POST_ROUTE("handleListCases")}`,
      "lib/services/leakService.ts": `// ${MARKER}\n${SERVICE("await db.insert(cases).values({});", false)}`,
      "lib/http/apiPipeline.ts": `// ${MARKER}\nconst gate = failClosedGate;\n`,
    });
    const violations = findViolations(root);
    expect(violations).toHaveLength(3);
    for (const message of violations) {
      expect(message).not.toContain(MARKER);
      expect(message).not.toContain("\\");
      expect(message).not.toContain(root);
    }
  });
});

describe("formatReport", () => {
  it("says OK and lists the exemptions", () => {
    const text = formatReport([]);
    expect(text.split("\n")[0]).toBe("OK");
    expect(text).toContain("exempt: db/seed.ts");
    expect(text).toContain("exempt: scripts/");
  });

  it("lists each violation and does not say OK", () => {
    const text = formatReport(["app/x/route.ts: a reason", "lib/y.ts: another"]);
    expect(text).not.toMatch(/^OK/);
    expect(text).toContain("- app/x/route.ts: a reason");
    expect(text).toContain("- lib/y.ts: another");
    expect(text).toContain("2 violation");
  });
});

describe("the command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/check-routes-gated.ts", ...args], { cwd: repo, encoding: "utf8" });

  it("prints OK and exits 0 for this repository", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("OK");
  }, 60_000);

  it("prints the violations and exits 1 for a repository with one", () => {
    const root = tree({ "app/api/v1/cases/route.ts": POST_ROUTE("handleListCases") });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("app/api/v1/cases/route.ts");
    expect(result.stdout).not.toMatch(/^OK/);
  }, 60_000);

  it("is wired into package.json and runs in CI right after lint", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:routes"]).toMatch(/scripts\/check-routes-gated\.ts/);
    const ci = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(ci.indexOf("pnpm check:routes")).toBeGreaterThan(ci.indexOf("pnpm lint"));
    expect(ci.indexOf("pnpm check:routes")).toBeLessThan(ci.indexOf("pnpm typecheck"));
  });
});
