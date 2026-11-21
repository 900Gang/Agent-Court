import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPS } from "@/lib/config/constants";

// N10 Task 6 (AC-1001): the cron schedule that Vercel runs. It must name exactly the scheduled routes, and each schedule
// must run as often as the gap that the metrics page and the missed-cron alert expect (OPS.cronJobs).

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons?: Array<{ path: string; schedule: string }> };
const crons = config.crons ?? [];

/** The gap in minutes between runs of the simple patterns used here, or null for a pattern this test does not read. */
function gapOf(schedule: string): number | null {
  const parts = schedule.split(" ");
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts;
  if (day !== "*" || month !== "*" || weekday !== "*") return null;
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === "*") return Number(every[1]);
  if (/^\d+$/.test(minute) && hour === "*") return 60;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) return 1440;
  return null;
}

describe("vercel.json", () => {
  it("exists and has crons", () => {
    expect(existsSync(path.join(root, "vercel.json"))).toBe(true);
    expect(crons.length).toBeGreaterThan(0);
  });

  it("schedules exactly the routes in OPS.cronJobs, each once", () => {
    const paths = crons.map((cron) => cron.path).sort();
    expect(paths).toEqual(Object.keys(OPS.cronJobs).map((route) => `/api/cron/${route}`).sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each(Object.entries(OPS.cronJobs))("runs %s as often as the gap of %s minutes", (route, expected) => {
    const cron = crons.find((entry) => entry.path === `/api/cron/${route}`);
    expect(cron, `no schedule for ${route}`).toBeDefined();
    expect(gapOf(cron!.schedule), `a schedule this test cannot read: ${cron!.schedule}`).toBe(expected);
  });

  it("uses only paths that have a route file", () => {
    for (const cron of crons) {
      expect(existsSync(path.join(root, "app", cron.path, "route.ts")), cron.path).toBe(true);
    }
  });

  it("puts nothing secret in the file", () => {
    const text = readFileSync(path.join(root, "vercel.json"), "utf8");
    expect(text).not.toMatch(/secret|token|bearer|password/i);
  });
});
