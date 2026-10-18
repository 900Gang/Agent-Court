import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database over our schema. Services accept this so the same code
 * runs against the postgres-js client in production and PGlite in tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<any, typeof schema>;
