import { describe, expect, it } from "vitest";
import { LIFECYCLE, REPUTATION } from "@/lib/config/constants";
import { appealDeadline, autoCloseAt, reminderStage, withinNoticeWindow } from "@/lib/lifecycle/rules";

const DAY = 86_400_000;
const t0 = new Date("2026-11-01T12:00:00.000Z");
const after = (ms: number) => new Date(t0.getTime() + ms);

describe("LIFECYCLE", () => {
  it("holds the numbers in one place", () => {
    expect(LIFECYCLE).toEqual({
      appealDays: 7,
      autoCloseDays: 14,
      reminderDays: [3, 7, 12],
      noticeWindowDays: 3,
      minAppeal: 10,
      maxAppeal: 500,
      cronBatch: 100,
    });
  });

  it("uses the same seven days for the appeal window and for holding points", () => {
    expect(LIFECYCLE.appealDays).toBe(REPUTATION.releaseDays);
  });

  it("sends the reminders before the case closes", () => {
    expect(Math.max(...LIFECYCLE.reminderDays)).toBeLessThan(LIFECYCLE.autoCloseDays);
    expect([...LIFECYCLE.reminderDays]).toEqual([...LIFECYCLE.reminderDays].sort((a, b) => a - b));
  });
});

describe("appealDeadline and autoCloseAt", () => {
  it("are exactly seven and fourteen days later", () => {
    expect(appealDeadline(t0).toISOString()).toBe("2026-11-08T12:00:00.000Z");
    expect(autoCloseAt(t0).toISOString()).toBe("2026-11-15T12:00:00.000Z");
  });

  it("do not change the date they are given", () => {
    const given = new Date(t0);
    appealDeadline(given);
    autoCloseAt(given);
    expect(given.getTime()).toBe(t0.getTime());
  });

  it("refuse a date that is not a date", () => {
    expect(() => appealDeadline(new Date("nope"))).toThrow(RangeError);
    expect(() => autoCloseAt(new Date("nope"))).toThrow(RangeError);
  });
});

describe("reminderStage", () => {
  it.each([
    [0, 0],
    [2 * DAY + 23 * 3600_000 + 59 * 60_000, 0],
    [3 * DAY - 1, 0],
    [3 * DAY, 3],
    [6 * DAY + 23 * 3600_000, 3],
    [7 * DAY - 1, 3],
    [7 * DAY, 7],
    [11 * DAY + 23 * 3600_000, 7],
    [12 * DAY - 1, 7],
    [12 * DAY, 12],
    [13 * DAY, 12],
    [400 * DAY, 12],
  ])("is right at %i ms after publication", (ms, stage) => {
    expect(reminderStage(t0, after(ms))).toBe(stage);
  });

  it("is 0 before publication, for an invalid date and for a missing one", () => {
    expect(reminderStage(t0, after(-DAY))).toBe(0);
    expect(reminderStage(new Date("nope"), t0)).toBe(0);
    expect(reminderStage(t0, new Date("nope"))).toBe(0);
    expect(reminderStage(null as unknown as Date, t0)).toBe(0);
  });

  it("always answers one of the configured days or 0", () => {
    const allowed = new Set([0, ...LIFECYCLE.reminderDays]);
    for (let hours = -48; hours < 24 * 30; hours += 7) expect(allowed.has(reminderStage(t0, after(hours * 3600_000)))).toBe(true);
  });
});

describe("withinNoticeWindow", () => {
  it.each([
    [0, true],
    [3600_000, true],
    [3 * DAY, true],
    [3 * DAY + 1, false],
    [30 * DAY, false],
    [-1, false],
    [-DAY, false],
  ])("an event that happened %i ms ago is announced: %s", (ago, announced) => {
    expect(withinNoticeWindow(after(-ago), t0)).toBe(announced);
  });

  it("does not announce an invalid or missing date", () => {
    expect(withinNoticeWindow(new Date("nope"), t0)).toBe(false);
    expect(withinNoticeWindow(t0, new Date("nope"))).toBe(false);
    expect(withinNoticeWindow(null as unknown as Date, t0)).toBe(false);
  });
});
