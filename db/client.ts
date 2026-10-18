import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getServerEnv } from "@/lib/config/env";
import * as schema from "./schema";

/**
 * Neon's copy-paste connection strings include `channel_binding=require`, which the
 * postgres driver would send to the server as an unknown setting. Strip it, keep the rest.
 */
export function normalizeDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the value: it contains a password.
    throw new Error("Invalid database URL");
  }
  if (!parsed.searchParams.has("channel_binding")) return url;
  parsed.searchParams.delete("channel_binding");
  return parsed.toString();
}

export interface ClientOptions {
  /** PgBouncer transaction mode cannot keep prepared statements. */
  prepare: false;
  /** Small pool: every serverless instance opens its own. */
  max: number;
  ssl: "require" | false;
  idle_timeout: number;
  connect_timeout: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function buildClientOptions(url: string): ClientOptions {
  const { hostname } = new URL(url);
  return {
    prepare: false,
    max: 5,
    ssl: LOCAL_HOSTS.has(hostname) ? false : "require",
    idle_timeout: 20,
    connect_timeout: 10,
  };
}

export function createDb(url: string) {
  const normalized = normalizeDatabaseUrl(url);
  const client = postgres(normalized, buildClientOptions(normalized));
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

// Kept on globalThis so Next.js dev hot reloads reuse one pool instead of opening a new one each time.
const globalForDb = globalThis as unknown as { __agentCourtDb?: Db };

/** The application database, connected as app_server through the pooled endpoint. */
export function getDb(): Db {
  globalForDb.__agentCourtDb ??= createDb(getServerEnv().databaseUrl);
  return globalForDb.__agentCourtDb;
}

/** Ends the shared connection pool. Scripts call this before exiting. */
export async function closeDb(): Promise<void> {
  const current = globalForDb.__agentCourtDb;
  globalForDb.__agentCourtDb = undefined;
  if (current) await current.$client.end();
}
