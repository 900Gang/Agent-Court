import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

export interface TestDb {
  db: PgliteDatabase<typeof schema>;
  pg: PGlite;
  /** Runs one statement as the current role and returns its rows. */
  sql: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

/**
 * In-process Postgres with pgvector. Creates a role that has no grants (`nobody`),
 * then applies every SQL file in db/migrations in name order.
 */
export async function createTestDb(): Promise<TestDb> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("no migrations found in db/migrations");
  }

  const pg = new PGlite({ extensions: { vector } });
  await pg.exec("create role nobody nologin;");
  for (const file of files) {
    await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  return {
    db: drizzle({ client: pg, schema }),
    pg,
    sql: async (query, params) => (await pg.query<Record<string, unknown>>(query, params)).rows,
    close: () => pg.close(),
  };
}