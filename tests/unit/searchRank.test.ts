import { describe, expect, it } from "vitest";
import { fuse, resolvedFirst } from "@/lib/search/rank";

describe("fuse: reciprocal rank fusion", () => {
  it("scores each case 1 / (k + rank) in every leg that holds it, and adds them", () => {
    const result = fuse([["a", "b"], ["b", "c"]], 60);
    const score = (id: string) => result.find((item) => item.id === id)?.score;
    expect(score("a")).toBeCloseTo(1 / 61, 10);
    expect(score("b")).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(score("c")).toBeCloseTo(1 / 62, 10);
  });

  it("puts a case found by both legs ahead of cases found by one", () => {
    expect(fuse([["a", "b"], ["b", "c"]]).map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("lets a high rank in one leg beat a low rank in both", () => {
    const first = Array.from({ length: 30 }, (_, i) => `x${i}`);
    const order = fuse([["top", ...first], [...first.slice().reverse(), "top"]]).map((item) => item.id);
    expect(order.indexOf("top")).toBeLessThan(order.indexOf("x15"));
  });

  it("uses 60 as the constant unless told otherwise", () => {
    expect(fuse([["a"]])[0].score).toBeCloseTo(1 / 61, 10);
    expect(fuse([["a"]], 0)[0].score).toBeCloseTo(1, 10);
  });

  it("breaks ties by where the case first appears: the first leg, then its order", () => {
    expect(fuse([["a"], ["b"]]).map((item) => item.id)).toEqual(["a", "b"]);
    expect(fuse([["b"], ["a"]]).map((item) => item.id)).toEqual(["b", "a"]);
    expect(fuse([["a", "b", "c"]]).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("copes with no legs, empty legs and one-case legs", () => {
    expect(fuse([])).toEqual([]);
    expect(fuse([[], []])).toEqual([]);
    expect(fuse([["only"], []]).map((item) => item.id)).toEqual(["only"]);
  });

  it("counts a case that appears twice in one leg only at its best place", () => {
    const result = fuse([["a", "b", "a"]]);
    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result[0].score).toBeCloseTo(1 / 61, 10);
  });
});

describe("resolvedFirst", () => {
  const items = [
    { id: "o1", resolved: false },
    { id: "r1", resolved: true },
    { id: "o2", resolved: false },
    { id: "r2", resolved: true },
  ];

  it("puts resolved cases first and keeps the order inside each group", () => {
    expect(resolvedFirst(items, (item) => item.resolved).map((item) => item.id)).toEqual(["r1", "r2", "o1", "o2"]);
  });

  it("changes nothing when there is nothing to move, and does not touch its input", () => {
    const none = [{ id: "a", resolved: false }];
    expect(resolvedFirst(none, (item) => item.resolved)).toEqual(none);
    const copy = items.map((item) => ({ ...item }));
    resolvedFirst(items, (item) => item.resolved);
    expect(items).toEqual(copy);
    expect(resolvedFirst([], () => true)).toEqual([]);
  });
});
