import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Runs one SQL statement and returns its rows. Rejects with an error that has a `code` on failure. */
export type Query = (sql: string) => Promise<Record<string, unknown>[]>;

const EXPECTED_ROLE = "app_server";
const MIN_TABLES = 16;

async function check(
  name: string,
  fn: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<CheckResult> {
  try {
    return { name, ...(await fn()) };
  } catch (error) {
    // Report the SQLSTATE code only: error messages can contain data.
    const code = (error as { code?: unknown }).code;
    return { name, ok: false, detail: `query failed (${typeof code === "string" ? code : "no code"})` };
  }
}

async function denied(query: Query, statement: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await query(statement);
    return { ok: false, detail: "the statement was allowed" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "42501" ? { ok: true } : { ok: false, detail: `unexpected error (${String(code)})` };
  }
}

/**
 * Verifies the database matches the security migration. `owner` runs as the project owner,
 * `app` runs as the application role. Every check runs even if an earlier one fails.
 */
export async function runDbChecks(owner: Query, app: Query): Promise<CheckResult[]> {
  const tableRows = await owner(
    `select relname, relrowsecurity, relforcerowsecurity from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
  ).catch(() => [] as Record<string, unknown>[]);
  const tables = tableRows.map((row) => String(row.relname));

  return [
    await check("RLS is enabled and forced on every table", async () => {
      const bad = tableRows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity);
      if (tableRows.length < MIN_TABLES) return { ok: false, detail: `found only ${tableRows.length} tables` };
      return bad.length === 0
        ? { ok: true, detail: `${tableRows.length} tables` }
        : { ok: false, detail: `not forced on: ${bad.map((row) => row.relname).join(", ")}` };
    }),

    await check("every table has one policy, for app_server only", async () => {
      const policies = await owner(
        `select tablename, roles::text as roles from pg_policies where schemaname = 'public'`,
      );
      const problems: string[] = [];
      for (const table of tables) {
        const mine = policies.filter((policy) => policy.tablename === table);
        if (mine.length !== 1 || mine[0].roles !== `{${EXPECTED_ROLE}}`) problems.push(table);
      }
      return problems.length === 0 ? { ok: true } : { ok: false, detail: `check: ${problems.join(", ")}` };
    }),

    await check("PUBLIC holds no table privileges", async () => {
      const rows = await owner(
        `select c.relname from pg_class c, aclexplode(c.relacl) a
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.grantee = 0`,
      );
      return rows.length === 0
        ? { ok: true }
        : { ok: false, detail: `granted on: ${rows.map((row) => row.relname).join(", ")}` };
    }),

    await check("PUBLIC cannot use the public schema", async () => {
      const rows = await owner(
        `select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'public' and a.grantee = 0`,
      );
      return rows.length === 0 ? { ok: true } : { ok: false, detail: "PUBLIC has a privilege on the schema" };
    }),

    await check("pgvector is installed", async () => {
      const rows = await owner(`select 1 from pg_extension where extname = 'vector'`);
      return rows.length === 1 ? { ok: true } : { ok: false, detail: "extension not found" };
    }),

    await check("verdict lock trigger exists", async () => {
      const rows = await owner(
        `select 1 from pg_trigger where tgname = 'arguments_lock_won' and not tgisinternal`,
      );
      return rows.length === 1 ? { ok: true } : { ok: false, detail: "trigger not found" };
    }),

    await check("connected as app_server", async () => {
      const [row] = await app(`select current_user as who`);
      return row?.who === EXPECTED_ROLE
        ? { ok: true }
        : { ok: false, detail: `DATABASE_URL connects as ${String(row?.who)}` };
    }),

    await check("app_server can read operators", async () => {
      await app(`select count(*)::int as n from operators`);
      return { ok: true };
    }),

    await check("app_server cannot update audit_log", () =>
      denied(app, `update audit_log set action = action where false`),
    ),

    await check("app_server cannot delete from verdicts", () =>
      denied(app, `delete from verdicts where false`),
    ),

    await check("no provider tokens are stored", async () => {
      const [row] = await app(
        `select count(*)::int as n from account
         where access_token is not null or refresh_token is not null or id_token is not null`,
      );
      return row?.n === 0 ? { ok: true } : { ok: false, detail: `${String(row?.n)} account rows hold a token` };
    }),
  ];
}

async function main(): Promise<void> {
  const ownerUrl = process.env.DATABASE_URL_DIRECT;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error("DATABASE_URL and DATABASE_URL_DIRECT must both be set");

  const { default: postgres } = await import("postgres");
  const { buildClientOptions, normalizeDatabaseUrl } = await import("@/db/client");
  const connect = (url: string) => {
    const normalized = normalizeDatabaseUrl(url);
    return postgres(normalized, { ...buildClientOptions(normalized), max: 1 });
  };
  const ownerSql = connect(ownerUrl);
  const appSql = connect(appUrl);
  const asQuery =
    (sql: ReturnType<typeof connect>): Query =>
    async (statement) =>
      [...(await sql.unsafe(statement))] as Record<string, unknown>[];

  let results: CheckResult[];
  try {
    results = await runDbChecks(asQuery(ownerSql), asQuery(appSql));
  } finally {
    await ownerSql.end();
    await appSql.end();
  }

  for (const result of results) {
    const suffix = result.detail ? ` (${result.detail})` : "";
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : suffix}`);
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "live check failed");
    process.exitCode = 1;
  });
}
