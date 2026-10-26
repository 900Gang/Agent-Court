import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage: pnpm check:routes [root]   (the root defaults to the current folder)
//
// A static check that no way of writing agent text skips the safety gate:
//   1. Every route that exports POST, PUT, PATCH or DELETE calls handlers that run the write pipeline (runApi with
//      write: true). The auth and cron routes have their own protection and are left out.
//   2. Every service that inserts into cases, evidence, arguments or agents imports screenSafely.
//   3. Nothing under app/, lib/ or components/ mentions failClosedGate except its own file: it is for tests.
// Messages name a file and a rule. They never quote the file.

export const EXEMPT: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "db/seed.ts", reason: "seeds trusted launch content by hand, before any agent exists" },
  { path: "scripts/", reason: "run by the operator on their own machine, not reachable from the network" },
];

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", ".git"]);
const PROTECTED_ROUTE_PREFIXES = ["app/api/auth/", "app/api/cron/"];
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const STUB_FILE = "lib/safety/stub.ts";

function walk(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return []; // a repository without this folder has nothing to check there
  }
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(full);
    return entry.isFile() ? [full] : [];
  });
}

const relativePath = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

type Source = { file: string; text: string };

function readSources(root: string, folders: string[], extensions: RegExp): Source[] {
  return folders
    .flatMap((folder) => walk(path.join(root, folder)))
    .filter((file) => extensions.test(file))
    .map((file) => ({ file: relativePath(root, file), text: readFileSync(file, "utf8") }));
}

/** The text of one exported function: from its declaration to the next export (or the end of the file). */
function exportedFunction(text: string, name: string): string | null {
  const match = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(text);
  if (!match) return null;
  const next = text.indexOf("\nexport ", match.index + 1);
  return text.slice(match.index, next === -1 ? undefined : next);
}

function handlerSources(root: string): string {
  return readSources(root, ["lib/http/handlers"], /\.ts$/)
    .map((source) => source.text)
    .join("\n");
}

type WriteRoute = { file: string; methods: string[]; handlers: string[]; unreadable: boolean };

function inspectRoutes(root: string): WriteRoute[] {
  const routes: WriteRoute[] = [];
  for (const { file, text } of readSources(root, ["app"], /(?:^|[\\/])route\.ts$/)) {
    if (PROTECTED_ROUTE_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;

    const methods: string[] = [];
    const handlers = new Set<string>();
    for (const method of WRITE_METHODS) {
      const body = exportedFunction(text, method);
      if (body === null) continue;
      methods.push(method);
      for (const match of body.matchAll(/\b(handle[A-Z]\w*)\(/g)) handlers.add(match[1]);
    }
    // `export const POST = ...`, `export { x as POST }` and the like: a form this check cannot follow.
    const names = WRITE_METHODS.join("|");
    const other = new RegExp(`export\\s+(?!(?:async\\s+)?function\\b)[^;]*\\b(?:${names})\\b`).test(text);
    if (methods.length > 0 || other) routes.push({ file, methods, handlers: [...handlers], unreadable: other });
  }
  return routes;
}

/** Write routes this check can follow, with the handlers each one calls. */
export function listWriteRoutes(root: string): Array<{ file: string; methods: string[]; handlers: string[] }> {
  return inspectRoutes(root)
    .filter((route) => route.methods.length > 0)
    .map(({ file, methods, handlers }) => ({ file, methods, handlers }));
}

function routeViolations(root: string): string[] {
  const handlers = handlerSources(root);
  const violations: string[] = [];
  for (const route of inspectRoutes(root)) {
    if (route.unreadable) {
      violations.push(`${route.file}: a write method is exported in a form this check cannot read`);
      continue;
    }
    if (route.handlers.length === 0) violations.push(`${route.file}: a write method calls no handler`);
    for (const name of route.handlers) {
      const body = exportedFunction(handlers, name);
      if (body === null) violations.push(`${route.file}: handler ${name} was not found in lib/http/handlers`);
      else if (!body.includes("runApi(")) violations.push(`${route.file}: handler ${name} does not run the API pipeline`);
      else if (!body.includes("write: true")) violations.push(`${route.file}: handler ${name} does not run as a write`);
    }
  }
  return violations;
}

const INSERT_INTO_AGENT_TEXT = [
  /\.insert\(\s*(?:cases|evidence|argumentsTable|agents)\b/,
  /insert\s+into\s+"?(?:cases|evidence|arguments|agents)\b/i,
];
const IMPORTS_SCREEN = /import\s*\{[^}]*\bscreenSafely\b[^}]*\}\s*from/;

function serviceViolations(root: string): string[] {
  return readSources(root, ["lib/services"], /\.ts$/)
    .filter(({ text }) => INSERT_INTO_AGENT_TEXT.some((pattern) => pattern.test(text)) && !IMPORTS_SCREEN.test(text))
    .map(({ file }) => `${file}: stores agent text without importing screenSafely`);
}

function stubViolations(root: string): string[] {
  return readSources(root, ["app", "lib", "components"], /\.tsx?$/)
    .filter(({ file, text }) => file !== STUB_FILE && /\bfailClosedGate\b/.test(text))
    .map(({ file }) => `${file}: mentions failClosedGate, which is for tests only`);
}

/** Every way a write path skips the gate, as "file: rule". An empty list means none was found. */
export function findViolations(root: string): string[] {
  return [...routeViolations(root), ...serviceViolations(root), ...stubViolations(root)].sort();
}

export function formatReport(violations: string[]): string {
  const exempt = EXEMPT.map((entry) => `exempt: ${entry.path} (${entry.reason})`);
  if (violations.length === 0) return ["OK", ...exempt].join("\n");
  return [`FAILED: ${violations.length} violation(s)`, ...violations.map((violation) => `- ${violation}`), ...exempt].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const violations = findViolations(root);
  console.log(formatReport(violations));
  process.exitCode = violations.length > 0 ? 1 : 0;
}
