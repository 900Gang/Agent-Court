import { EMBEDDING } from "@/lib/config/constants";

export type EmbeddingErrorCode = "timeout" | "http" | "shape" | "network";

// Fixed text per code. Nothing from the request, the response or the connection error is ever put into an error:
// the input is case text, the response may echo it, and the key travels in a header.
const MESSAGES: Record<EmbeddingErrorCode, string> = {
  timeout: "the embedding service did not answer in time",
  http: "the embedding service refused the request",
  shape: "the embedding service answered with something unexpected",
  network: "the embedding service could not be reached",
};

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  /** The HTTP status, for the `http` code only. */
  readonly status: number | undefined;

  constructor(code: EmbeddingErrorCode, status?: number) {
    super(MESSAGES[code]);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = status;
  }
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** One vector per text, in the order of the texts. Fails with an EmbeddingError. */
  embed(texts: string[], options?: { timeoutMs?: number }): Promise<number[][]>;
}

const ENDPOINT = "https://api.openai.com/v1/embeddings";

function isVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/** Checks the answer and puts the vectors in the order of the inputs. Any deviation is a `shape` error. */
function readVectors(body: unknown, count: number, dimensions: number): number[][] {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== count) throw new EmbeddingError("shape");
  const ordered: Array<number[] | undefined> = new Array(count).fill(undefined);
  for (const item of data) {
    const { index, embedding } = (typeof item === "object" && item !== null ? item : {}) as { index?: unknown; embedding?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) throw new EmbeddingError("shape");
    if (ordered[index] !== undefined || !isVector(embedding, dimensions)) throw new EmbeddingError("shape");
    ordered[index] = embedding;
  }
  return ordered as number[][];
}

/** The OpenAI embeddings endpoint, called with a plain fetch. The key never leaves the Authorization header. */
export function createOpenAiProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EmbeddingProvider {
  return {
    model: EMBEDDING.model,
    dimensions: EMBEDDING.dimensions,
    async embed(texts, options = {}) {
      if (texts.length === 0) return [];
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? EMBEDDING.requestTimeoutMs);
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: EMBEDDING.model, input: texts, encoding_format: "float" }),
          signal: controller.signal,
        });
        // The body of a refusal is never read: it can echo the input.
        if (!response.ok) throw new EmbeddingError("http", response.status);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new EmbeddingError(timedOut ? "timeout" : "shape");
        }
        return readVectors(body, texts.length, EMBEDDING.dimensions);
      } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        throw new EmbeddingError(timedOut ? "timeout" : "network");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
