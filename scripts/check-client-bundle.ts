import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_SECRET_LENGTH = 12;
const SECRET_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_SECRET",
  "UPSTASH_REDIS_REST_TOKEN",
  "CRON_SECRET",
  "OPENAI_API_KEY",
] as const;
const URL_VARIABLES = ["DATABASE_URL", "DATABASE_URL_DIRECT"] as const;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Paths under `dir` (recursive) whose bytes contain any secret. Secrets under 12 characters are ignored. */
export async function findLeaks(dir: string, secrets: string[]): Promise<string[]> {
  await stat(dir); // rejects when the folder does not exist
  const needles = [...new Set(secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH))];
  if (needles.length === 0) return [];

  const leaks: string[] = [];
  for await (const file of walk(dir)) {
    const content = await readFile(file);
    if (needles.some((needle) => content.includes(needle))) leaks.push(file);
  }
  return leaks.sort();
}

/** Server-only values that must never appear in browser code: the secrets and database passwords. */
export function collectSecrets(env: Record<string, string | undefined>): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= MIN_SECRET_LENGTH) found.add(value);
  };

  for (const name of SECRET_VARIABLES) add(env[name]);
  for (const name of URL_VARIABLES) {
    const raw = env[name];
    if (!raw) continue;
    try {
      const { password } = new URL(raw);
      add(password);
      add(decodeURIComponent(password));
    } catch {
      // Not a parseable URL: the whole value is already covered above.
    }
  }
  return [...found];
}

export async function checkBundle(
  dir: string,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; message: string }> {
  const secrets = collectSecrets(env);
  if (secrets.length === 0) {
    return {
      ok: false,
      message:
        "No secrets configured to check (set DATABASE_URL, BETTER_AUTH_SECRET, GITHUB_CLIENT_SECRET). Refusing to pass without checking anything.",
    };
  }

  try {
    await stat(dir);
  } catch {
    return { ok: false, message: `Build output not found: ${dir}. Run pnpm build first.` };
  }

  const leaks = await findLeaks(dir, secrets);
  if (leaks.length > 0) {
    const names = leaks.map((file) => ` - ${path.relative(dir, file)}`).join("\n");
    return { ok: false, message: `A server secret was found in client bundle files:\n${names}` };
  }
  return { ok: true, message: `No leaks: checked ${secrets.length} secret values in ${dir}` };
}

async function main(): Promise<void> {
  const target = path.resolve(process.argv[2] ?? ".next/static");
  const result = await checkBundle(target, process.env);
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "bundle check failed");
    process.exitCode = 1;
  });
}
