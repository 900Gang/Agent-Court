import { describe, expect, it } from "vitest";
import { evaluate, percentile, scoreRecall } from "@/lib/search/evaluate";

describe("scoreRecall", () => {
  const truth = { q1: "a", q2: "b", q3: "c" };

  it("counts a query as a hit when its true case is among the first three results", () => {
    expect(scoreRecall({ q1: ["a", "x"], q2: ["x", "b"], q3: ["x", "y", "c"] }, truth)).toEqual({ hits: 3, total: 3, rate: 1 });
  });

  it("counts a miss when the true case is not there", () => {
    expect(scoreRecall({ q1: ["x"], q2: ["y", "z"], q3: [] }, truth)).toEqual({ hits: 0, total: 3, rate: 0 });
  });

  it("gives a partial rate", () => {
    const result = scoreRecall({ q1: ["a"], q2: ["x"], q3: ["x"] }, truth);
    expect(result.hits).toBe(1);
    expect(result.total).toBe(3);
    expect(result.rate).toBeCloseTo(1 / 3, 10);
  });

  it("does not count a hit at rank four unless asked for four", () => {
    expect(scoreRecall({ q1: ["x", "y", "z", "a"] }, { q1: "a" }).hits).toBe(0);
    expect(scoreRecall({ q1: ["x", "y", "z", "a"] }, { q1: "a" }, 4).hits).toBe(1);
  });

  it("counts a query that has no results at all as a miss, and counts every query that has a true case", () => {
    expect(scoreRecall({ q1: ["a"] }, truth)).toEqual({ hits: 1, total: 3, rate: 1 / 3 });
  });

  it("ignores results for queries that have no true case", () => {
    expect(scoreRecall({ q1: ["a"], other: ["a"] }, { q1: "a" })).toEqual({ hits: 1, total: 1, rate: 1 });
  });

  it("gives a rate of 0, not NaN, when there is nothing to score", () => {
    expect(scoreRecall({}, {})).toEqual({ hits: 0, total: 0, rate: 0 });
  });
});

describe("evaluate", () => {
  const queries = [
    { id: "q1", text: "first query", truth: "a" },
    { id: "q2", text: "second query", truth: "b" },
    { id: "q3", text: "third query", truth: "c" },
    { id: "q4", text: "fourth query", truth: "d" },
  ];

  it("runs every query through the search and scores the answers", async () => {
    const asked: string[] = [];
    const result = await evaluate(queries, async (text) => {
      asked.push(text);
      return [queries.find((query) => query.text === text)?.truth ?? "none"];
    });
    expect(asked).toEqual(queries.map((query) => query.text));
    expect(result).toMatchObject({ hits: 4, total: 4, rate: 1, misses: [] });
  });

  it("gives a rate of 0 for a search that never finds the true case, and names the queries it missed", async () => {
    const result = await evaluate(queries, async () => ["nothing"]);
    expect(result).toMatchObject({ hits: 0, total: 4, rate: 0 });
    expect(result.misses).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("counts a true case in second or third place, and not in fourth", async () => {
    const answers: Record<string, string[]> = {
      "first query": ["x", "a"],
      "second query": ["x", "y", "b"],
      "third query": ["x", "y", "z", "c"],
      "fourth query": ["d"],
    };
    const result = await evaluate(queries, async (text) => answers[text]);
    expect(result).toMatchObject({ hits: 3, total: 4, rate: 0.75 });
    expect(result.misses).toEqual(["q3"]);
  });

  it("gives a rate of 0 for no queries", async () => {
    expect(await evaluate([], async () => [])).toEqual({ hits: 0, total: 0, rate: 0, misses: [] });
  });
});

describe("percentile", () => {
  it("interpolates between the sorted values", () => {
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 25)).toBe(2);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([1, 2], 50)).toBeCloseTo(1.5, 10);
  });

  it("gives the only value of a single value, and NaN for none", () => {
    expect(percentile([7], 10)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it("does not change its input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});
