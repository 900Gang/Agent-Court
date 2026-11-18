import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricsTables, formatAge, formatTime, percent } from "@/components/admin/MetricsTables";
import type { MetricsView } from "@/lib/services/metricsService";

// N10 Task 4 (AC-1005): the tables on /admin/metrics. Plain text nodes, honest about what is unknown.

const NOW = new Date("2026-11-18T12:30:00.000Z");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const day = (n: number, over: Record<string, unknown> = {}) => ({
  day: `2026-11-${String(12 + n).padStart(2, "0")}`,
  cases: n,
  importedCases: 0,
  verdicts: 0,
  screened: 0,
  flagged: 0,
  requests: 0,
  rateLimited: 0,
  ...over,
});
const hour = (n: number, over: Record<string, unknown> = {}) => ({ hour: `2026-11-18 ${String(n).padStart(2, "0")}`, screened: 0, flagged: 0, requests: 0, rateLimited: 0, ...over });

const view = (over: Partial<MetricsView> = {}): MetricsView => ({
  generatedAt: NOW,
  days: Array.from({ length: 7 }, (_unused, n) => day(n)) as never,
  hours: Array.from({ length: 24 }, (_unused, n) => hour(n)) as never,
  resolution: { eligible: 8, resolved: 6 },
  cron: [
    { route: "reminders", expectedMinutes: 60, lastRunAt: new Date(NOW.getTime() - 10 * 60_000), lastOkAt: new Date(NOW.getTime() - 10 * 60_000), state: "ok" },
    { route: "reembed", expectedMinutes: 15, lastRunAt: new Date(NOW.getTime() - 200 * 60_000), lastOkAt: new Date(NOW.getTime() - 200 * 60_000), state: "overdue" },
    { route: "rescan", expectedMinutes: 1440, lastRunAt: null, lastOkAt: null, state: "never" },
    { route: "auto-close", expectedMinutes: 1440, lastRunAt: new Date(NOW.getTime() - 5 * 60_000), lastOkAt: null, state: "failed" },
  ] as never,
  countersAvailable: true,
  ...over,
});

describe("percent", () => {
  it.each([
    [1, 4, "25.0%"],
    [0, 4, "0.0%"],
    [1, 3, "33.3%"],
    [5, 0, "-"],
    [null, 4, "-"],
    [4, null, "-"],
    [1, -1, "-"],
  ])("%s of %s is %s", (part, whole, expected) => {
    expect(percent(part as never, whole as never)).toBe(expected);
  });
});

describe("formatTime and formatAge", () => {
  it("formats a time in UTC, or a dash", () => {
    expect(formatTime(new Date("2026-11-18T09:05:59.000Z"))).toBe("2026-11-18 09:05 UTC");
    expect(formatTime(null)).toBe("-");
  });

  it.each([
    [0, "0 min ago"],
    [59, "59 min ago"],
    [60, "1 h ago"],
    [180, "3 h ago"],
    [2880, "2 d ago"],
  ])("%s minutes is %s", (minutes, expected) => {
    expect(formatAge(new Date(NOW.getTime() - minutes * 60_000), NOW)).toBe(expected);
  });

  it("gives a dash when there is no time, and never a negative age", () => {
    expect(formatAge(null, NOW)).toBe("-");
    expect(formatAge(new Date(NOW.getTime() + 60_000), NOW)).toBe("0 min ago");
  });
});

describe("MetricsTables", () => {
  it("shows the newest day first and the newest hour first", () => {
    const content = text(renderToStaticMarkup(<MetricsTables view={view()} />));
    expect(content.indexOf("2026-11-18")).toBeLessThan(content.indexOf("2026-11-12"));
    expect(content.indexOf("2026-11-18 23")).toBeLessThan(content.indexOf("2026-11-18 00"));
  });

  it("shows rates as percentages and a dash where there is nothing to divide by", () => {
    const content = text(
      renderToStaticMarkup(
        <MetricsTables view={view({ days: [day(0, { screened: 8, flagged: 2, requests: 200, rateLimited: 50 }), ...Array.from({ length: 6 }, (_unused, n) => day(n + 1))] as never })} />,
      ),
    );
    expect(content).toContain("25.0%");
    expect(content).toContain("-");
  });

  it("shows the verdict rate with its two counts", () => {
    const content = text(renderToStaticMarkup(<MetricsTables view={view()} />));
    expect(content).toContain("older than 7 days: 8");
    expect(content).toContain("With a verdict: 6");
    expect(content).toContain("75.0%");
  });

  it("shows a dash when no case is old enough", () => {
    expect(text(renderToStaticMarkup(<MetricsTables view={view({ resolution: { eligible: 0, resolved: 0 } })} />))).toContain("(-)");
  });

  it("says unknown, not zero, when the counters could not be read", () => {
    const unknownDays = Array.from({ length: 7 }, (_unused, n) => day(n, { requests: null, rateLimited: null }));
    const unknownHours = Array.from({ length: 24 }, (_unused, n) => hour(n, { requests: null, rateLimited: null }));
    const content = text(renderToStaticMarkup(<MetricsTables view={view({ countersAvailable: false, days: unknownDays as never, hours: unknownHours as never })} />));
    expect(content).toMatch(/could not be read/);
    expect(content).toContain("?");
  });

  it("says nothing about counters when they were read", () => {
    expect(text(renderToStaticMarkup(<MetricsTables view={view()} />))).not.toMatch(/could not be read/);
  });

  it("marks each scheduled route with its state in words", () => {
    const markup = renderToStaticMarkup(<MetricsTables view={view()} />);
    expect(markup).toMatch(/chip-ok[^>]*>OK</);
    expect(markup).toMatch(/chip-warn[^>]*>OVERDUE</);
    expect(markup).toMatch(/chip-warn[^>]*>FAILED</);
    expect(markup).toMatch(/chip-off[^>]*>NEVER RUN</);
  });

  it("shows the gap of each route in plain units and the last run with its age", () => {
    const content = text(renderToStaticMarkup(<MetricsTables view={view()} />));
    expect(content).toContain("reminders 1 h");
    expect(content).toContain("reembed 15 min");
    expect(content).toContain("rescan 1 d");
    expect(content).toContain("(10 min ago)");
  });

  it("shows nothing that could be markup", () => {
    const markup = renderToStaticMarkup(<MetricsTables view={view()} />);
    expect(markup).not.toMatch(/<script/i);
  });
});
