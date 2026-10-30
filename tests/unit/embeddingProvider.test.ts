import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING, SEARCH_TUNING } from "@/lib/config/constants";
import { createOpenAiProvider, EmbeddingError } from "@/lib/embeddings/provider";

const KEY = "sk-test-SENTINEL_KEY_VALUE_0123456789";
const INPUT_A = "SENTINEL_INPUT_ALPHA text of the first case";
const INPUT_B = "SENTINEL_INPUT_BETA text of the second case";
const BODY = "SENTINEL_BODY_FROM_SERVER";
const DIMS = 1536;

const vector = (seed = 1, dims = DIMS) => Array.from({ length: dims }, (_, i) => ((i + seed) % 7) / 10);
const answer = (vectors: number[][], over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ object: "list", model: EMBEDDING.model, data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })), ...over }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit };
function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => vi.restoreAllMocks());

async function failureOf(promise: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingError);
    return error as EmbeddingError;
  }
  throw new Error("expected the call to fail");
}

/** An error says what kind of failure it was and nothing else: no key, no input, no body, no cause. */
function expectClean(error: EmbeddingError) {
  const parts = [error.message, String(error), error.stack ?? "", JSON.stringify(error)];
  for (const name of Object.getOwnPropertyNames(error)) parts.push(String((error as unknown as Record<string, unknown>)[name]));
  const everything = parts.join(" ");
  for (const secret of [KEY, "SENTINEL_INPUT", BODY, "Bearer"]) expect(everything, secret).not.toContain(secret);
  expect(error.cause).toBeUndefined();
}

describe("the tuning constants", () => {
  it("name the agreed model and numbers", () => {
    expect(EMBEDDING).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536, requestTimeoutMs: 3000, cronTimeoutMs: 20000 });
    expect(SEARCH_TUNING).toMatchObject({ legSize: 50, rrfK: 60, similarLimit: 3, cronBatch: 25 });
    expect(SEARCH_TUNING.minSimilarity).toBeGreaterThan(0);
    expect(SEARCH_TUNING.minSimilarity).toBeLessThan(1);
  });
});

describe("createOpenAiProvider: the request", () => {
  it("states its model and its dimension", () => {
    const provider = createOpenAiProvider(KEY, recordingFetch(() => answer([])).fetchImpl);
    expect(provider.model).toBe(EMBEDDING.model);
    expect(provider.dimensions).toBe(EMBEDDING.dimensions);
  });

  it("posts the inputs to the embeddings endpoint with the key and the model", async () => {
    const { fetchImpl, calls } = recordingFetch(() => answer([vector(1), vector(2)]));
    await createOpenAiProvider(KEY, fetchImpl).embed([INPUT_A, INPUT_B]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toMatch(/application\/json/);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: EMBEDDING.model, input: [INPUT_A, INPUT_B], encoding_format: "float" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes no request at all for an empty list", async () => {
    const { fetchImpl, calls } = recordingFetch(() => answer([]));
    await expect(createOpenAiProvider(KEY, fetchImpl).embed([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("createOpenAiProvider: a good answer", () => {
  it("returns the vectors in the order of the inputs, even when the service sends them out of order", async () => {
    const first = vector(1);
    const second = vector(2);
    const response = new Response(
      JSON.stringify({ data: [{ index: 1, embedding: second }, { index: 0, embedding: first }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await createOpenAiProvider(KEY, recordingFetch(() => response).fetchImpl).embed([INPUT_A, INPUT_B]);
    expect(result).toEqual([first, second]);
  });
});

describe("createOpenAiProvider: a bad answer is a shape error", () => {
  const cases: Array<[string, () => Response]> = [
    ["a vector that is too short", () => answer([vector(1, DIMS - 1)])],
    ["a vector that is too long", () => answer([vector(1, DIMS + 1)])],
    ["fewer vectors than inputs", () => answer([vector(1)])],
    ["more vectors than inputs", () => answer([vector(1), vector(2), vector(3)])],
    ["data that is not a list", () => new Response(JSON.stringify({ data: "nope" }), { status: 200 })],
    ["a body that is not JSON", () => new Response("<html>not json</html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["a vector with a value that is not a number", () => answer([[...vector(1).slice(1), "x" as unknown as number]])],
    ["a vector with a missing value", () => answer([[...vector(1).slice(1), null as unknown as number]])],
    ["two items with the same index", () => new Response(JSON.stringify({ data: [{ index: 0, embedding: vector(1) }, { index: 0, embedding: vector(2) }] }), { status: 200 })],
    ["an item with no index", () => new Response(JSON.stringify({ data: [{ embedding: vector(1) }, { embedding: vector(2) }] }), { status: 200 })],
  ];

  it.each(cases)("%s", async (_label, respond) => {
    const error = await failureOf(createOpenAiProvider(KEY, recordingFetch(respond).fetchImpl).embed((["fewer", "more", "two items", "an item"].some((prefix) => _label.startsWith(prefix)) ? [INPUT_A, INPUT_B] : [INPUT_A])));
    expect(error.code).toBe("shape");
    expectClean(error);
  });
});

describe("createOpenAiProvider: a refusal is an http error", () => {
  it.each([400, 401, 403, 404, 429, 500, 503])("status %i", async (status) => {
    const respond = () => new Response(JSON.stringify({ error: { message: BODY } }), { status, headers: { "content-type": "application/json" } });
    const error = await failureOf(createOpenAiProvider(KEY, recordingFetch(respond).fetchImpl).embed([INPUT_A]));
    expect(error.code).toBe("http");
    expect(error.status).toBe(status);
    expectClean(error);
  });
});

describe("createOpenAiProvider: time and network", () => {
  it("gives up at the timeout and says so", async () => {
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const started = Date.now();
    const error = await failureOf(createOpenAiProvider(KEY, hanging).embed([INPUT_A], { timeoutMs: 25 }));
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expectClean(error);
  });

  it("reports a failed connection without the text of the failure", async () => {
    const broken = (async () => {
      throw new TypeError(`fetch failed: ${KEY} ${INPUT_A} ${BODY}`);
    }) as typeof fetch;
    const error = await failureOf(createOpenAiProvider(KEY, broken).embed([INPUT_A]));
    expect(error.code).toBe("network");
    expectClean(error);
  });

  it("writes nothing to the console, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    await createOpenAiProvider(KEY, recordingFetch(() => answer([vector(1)])).fetchImpl).embed([INPUT_A]);
    await failureOf(createOpenAiProvider(KEY, recordingFetch(() => new Response(BODY, { status: 500 })).fetchImpl).embed([INPUT_A]));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("EmbeddingError", () => {
  it.each(["timeout", "http", "shape", "network"] as const)("carries the code %s", (code) => {
    const error = new EmbeddingError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe("EmbeddingError");
    expect(error.message.length).toBeGreaterThan(0);
  });
});
