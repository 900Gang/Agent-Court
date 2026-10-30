import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/env", () => ({ getServerEnv: vi.fn() }));

import { getServerEnv } from "@/lib/config/env";
import { getEmbeddingProvider } from "@/lib/embeddings/server";

const env = (openAiApiKey: string | null) => vi.mocked(getServerEnv).mockReturnValue({ openAiApiKey } as ReturnType<typeof getServerEnv>);

describe("getEmbeddingProvider", () => {
  beforeEach(() => vi.mocked(getServerEnv).mockReset());

  it("is null when there is no key, so every caller falls back", () => {
    env(null);
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("is the OpenAI provider when there is a key", () => {
    env("sk-test-SENTINEL_KEY_VALUE_0123456789");
    const provider = getEmbeddingProvider();
    expect(provider?.model).toBe("text-embedding-3-small");
    expect(provider?.dimensions).toBe(1536);
  });

  it("gives the same provider each time", () => {
    env("sk-test-SENTINEL_KEY_VALUE_0123456789");
    expect(getEmbeddingProvider()).toBe(getEmbeddingProvider());
  });
});
