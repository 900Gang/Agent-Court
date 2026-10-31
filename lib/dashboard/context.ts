import "server-only";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { getOperator } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/env";
import { getEmbeddingProvider } from "@/lib/embeddings/server";
import type { ActionDeps } from "./actionsCore";

/** The real dependencies for a dashboard action: database, signed-in operator, request headers, own origin. */
export async function buildActionDeps(): Promise<ActionDeps> {
  return {
    db: getDb(),
    operator: await getOperator(),
    headers: await headers(),
    expectedOrigin: getServerEnv().betterAuthUrl,
    embedder: getEmbeddingProvider(),
  };
}
