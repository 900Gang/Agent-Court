import "server-only";
import { getServerEnv } from "@/lib/config/env";
import { createOpenAiProvider, type EmbeddingProvider } from "./provider";

let cached: { key: string; provider: EmbeddingProvider } | undefined;

/** The real provider, or null when no key is set: every caller then falls back to keyword search. */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const key = getServerEnv().openAiApiKey;
  if (key === null) return null;
  if (cached?.key !== key) cached = { key, provider: createOpenAiProvider(key) };
  return cached.provider;
}
