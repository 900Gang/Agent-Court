import { describe, expect, it } from "vitest";
import { EmbeddingError } from "@/lib/embeddings/provider";
import { createRecordingProvider, fakeVector, slowProvider, throwingProvider, unitVector } from "../helpers/embeddings";

const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0) / (norm(a) * norm(b));

describe("the recording provider", () => {
  it("remembers exactly what it was sent, call by call", async () => {
    const recording = createRecordingProvider();
    await recording.embed(["first", "second"]);
    await recording.embed(["third"]);
    expect(recording.calls).toEqual([["first", "second"], ["third"]]);
    expect(recording.received()).toEqual(["first", "second", "third"]);
  });

  it("answers with one unit vector of the agreed length for each text, the same one every time", async () => {
    const recording = createRecordingProvider();
    const [first, second] = await recording.embed(["same text", "other text"]);
    const [again] = await recording.embed(["same text"]);
    expect(first).toHaveLength(recording.dimensions);
    expect(norm(first)).toBeCloseTo(1, 6);
    expect(again).toEqual(first);
    expect(second).not.toEqual(first);
    expect(Math.abs(cosine(first, second))).toBeLessThan(0.5);
  });

  it("answers with the vector it was told to for a text, and still records the text", async () => {
    const chosen = unitVector(3);
    const recording = createRecordingProvider({ "pinned text": chosen });
    const [pinned] = await recording.embed(["pinned text"]);
    expect(pinned).toEqual(chosen);
    expect(recording.received()).toEqual(["pinned text"]);
  });

  it("states a model and a dimension like a real provider", () => {
    const recording = createRecordingProvider();
    expect(recording.model).toBe("test-embedding-model");
    expect(recording.dimensions).toBe(1536);
  });
});

describe("the vectors the helpers build", () => {
  it("makes a unit vector with a single 1 at the chosen place", () => {
    const vector = unitVector(5);
    expect(vector).toHaveLength(1536);
    expect(vector[5]).toBe(1);
    expect(vector.filter((value) => value !== 0)).toHaveLength(1);
  });

  it("makes a stable unit vector from any text", () => {
    expect(fakeVector("a")).toEqual(fakeVector("a"));
    expect(fakeVector("a")).not.toEqual(fakeVector("b"));
    expect(norm(fakeVector("a"))).toBeCloseTo(1, 6);
  });
});

describe("the failing providers", () => {
  it("throwingProvider fails with a network error and records the attempt", async () => {
    const error = await throwingProvider.embed(["x"]).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe("network");
  });

  it("slowProvider answers after its delay, and fails with a timeout when told to wait less", async () => {
    const slow = slowProvider(60);
    const started = Date.now();
    await expect(slow.embed(["x"])).resolves.toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    const error = await slow.embed(["x"], { timeoutMs: 10 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe("timeout");
  });
});
