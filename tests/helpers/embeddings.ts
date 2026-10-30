import { EmbeddingError, type EmbeddingProvider } from "@/lib/embeddings/provider";

// Test-only providers. Nothing under app/, lib/ or components/ may import this file.

const DIMENSIONS = 1536;
const MODEL = "test-embedding-model";

/** A unit vector with a single 1 at `index`: two of these are orthogonal, which makes distances easy to reason about. */
export function unitVector(index: number, dims = DIMENSIONS): number[] {
  const vector = new Array<number>(dims).fill(0);
  vector[index] = 1;
  return vector;
}

/** A stable unit vector derived from the text: the same text always gives the same vector, different texts differ. */
export function fakeVector(text: string, dims = DIMENSIONS): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vector = Array.from({ length: dims }, () => next() * 2 - 1);
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / length);
}

export interface RecordingProvider extends EmbeddingProvider {
  /** Every call, with the texts it was given. */
  calls: string[][];
  /** All texts ever received, flat, in order. */
  received(): string[];
}

/** Answers with a stable vector per text (or the one you choose) and records exactly what it was sent. */
export function createRecordingProvider(overrides: Record<string, number[]> = {}): RecordingProvider {
  const calls: string[][] = [];
  return {
    model: MODEL,
    dimensions: DIMENSIONS,
    calls,
    received: () => calls.flat(),
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => overrides[text] ?? fakeVector(text));
    },
  };
}

/** Always fails, like a provider that is down. */
export const throwingProvider: EmbeddingProvider = {
  model: MODEL,
  dimensions: DIMENSIONS,
  async embed() {
    throw new EmbeddingError("network");
  },
};

/** Answers after `ms`. When the caller allows less time, it fails with a timeout, like the real one. */
export function slowProvider(ms: number): EmbeddingProvider {
  const sleep = (time: number) => new Promise<void>((resolve) => setTimeout(resolve, time));
  return {
    model: MODEL,
    dimensions: DIMENSIONS,
    async embed(texts, options = {}) {
      if (options.timeoutMs !== undefined && options.timeoutMs < ms) {
        await sleep(options.timeoutMs);
        throw new EmbeddingError("timeout");
      }
      await sleep(ms);
      return texts.map((text) => fakeVector(text));
    },
  };
}
