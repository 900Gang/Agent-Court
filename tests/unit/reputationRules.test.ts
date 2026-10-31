import { describe, expect, it } from "vitest";
import { REPUTATION } from "@/lib/config/constants";
import { awardPoints, capReason, releaseAt, tierFor } from "@/lib/reputation/rules";

describe("the numbers", () => {
  it("are the agreed ones, in one place", () => {
    expect(REPUTATION).toMatchObject({
      pointsPerVerdict: 10,
      pairwiseSchedule: [10, 10, 10, 5, 2, 0],
      tierThresholds: [30, 100, 300],
      releaseDays: 7,
      maxNote: 500,
    });
  });
});

describe("awardPoints: the pairwise cap", () => {
  it.each([
    [0, 10],
    [1, 10],
    [2, 10],
    [3, 5],
    [4, 2],
    [5, 0],
    [6, 0],
    [50, 0],
  ])("pays %i earlier awards between the same two operators %i points", (prior, points) => {
    expect(awardPoints(prior)).toBe(points);
  });

  it("never pays more than the first award, and never pays more as the count grows", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let prior = 0; prior < 20; prior++) {
      const points = awardPoints(prior);
      expect(points).toBeLessThanOrEqual(REPUTATION.pointsPerVerdict);
      expect(points).toBeLessThanOrEqual(previous);
      previous = points;
    }
  });

  it.each([[-1], [-100], [1.5], [0.1], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER], [Number.MAX_VALUE]])(
    "pays nothing for a count that is not a whole number of at least 0 (%j): it fails closed",
    (prior) => {
      expect(awardPoints(prior)).toBe(0);
    },
  );
});

describe("tierFor", () => {
  it.each([
    [0, 0],
    [1, 0],
    [29, 0],
    [29.9, 0],
    [30, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 3],
    [10_000, 3],
  ])("gives %d final points tier %i", (points, tier) => {
    expect(tierFor(points)).toBe(tier);
  });

  it.each([[-5], [-1], [Number.NaN]])("gives %j tier 0", (points) => {
    expect(tierFor(points)).toBe(0);
  });

  it("never goes down as points go up", () => {
    let previous = 0;
    for (let points = 0; points <= 400; points++) {
      const tier = tierFor(points);
      expect(tier).toBeGreaterThanOrEqual(previous);
      previous = tier;
    }
  });
});

describe("releaseAt", () => {
  it("is exactly seven days after the verdict", () => {
    const verdict = new Date("2026-10-31T12:34:56.789Z");
    expect(releaseAt(verdict).toISOString()).toBe("2026-11-07T12:34:56.789Z");
  });

  it("does not change the date it was given", () => {
    const verdict = new Date("2026-01-01T00:00:00.000Z");
    releaseAt(verdict);
    expect(verdict.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("counts whole days across a month and a year", () => {
    expect(releaseAt(new Date("2026-12-28T00:00:00.000Z")).toISOString()).toBe("2027-01-04T00:00:00.000Z");
  });
});

describe("capReason", () => {
  it.each([
    [0, "verdict_win"],
    [1, "verdict_win"],
    [2, "verdict_win"],
    [3, "verdict_win_capped_5"],
    [4, "verdict_win_capped_2"],
    [5, "verdict_win_capped_0"],
    [99, "verdict_win_capped_0"],
  ])("gives %i earlier awards the reason %s", (prior, reason) => {
    expect(capReason(prior)).toBe(reason);
  });

  it.each([[Number.NaN], [-3], [1.5]])("says capped to zero for a count that is not valid (%j), and holds nothing of the input", (prior) => {
    expect(capReason(prior)).toBe("verdict_win_capped_0");
  });

  it("is always one of a short list of fixed strings", () => {
    const allowed = new Set(["verdict_win", "verdict_win_capped_5", "verdict_win_capped_2", "verdict_win_capped_0"]);
    for (let prior = -2; prior < 12; prior++) expect(allowed.has(capReason(prior))).toBe(true);
  });
});
