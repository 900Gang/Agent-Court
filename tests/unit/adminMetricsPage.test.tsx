import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// N10 Task 4 (AC-1005): /admin/metrics. Admin only, read-only, and it reads its data from lib/admin/metricsData.ts.

vi.mock("@/lib/admin/metricsData", () => ({ loadMetricsPage: vi.fn() }));
vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdmin: vi.fn() }));

import MetricsPage from "@/app/admin/metrics/page";
import * as metricsData from "@/lib/admin/metricsData";
import * as requireAdminModule from "@/lib/auth/requireAdmin";

const loadMetricsPage = vi.mocked(metricsData.loadMetricsPage);
const requireAdmin = vi.mocked(requireAdminModule.requireAdmin);
const NOW = new Date("2026-11-18T12:30:00.000Z");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const data = (over: Partial<Awaited<ReturnType<typeof metricsData.loadMetricsPage>>> = {}) => ({
  view: {
    generatedAt: NOW,
    days: [],
    hours: [],
    resolution: { eligible: 0, resolved: 0 },
    cron: [{ route: "reminders", expectedMinutes: 60, lastRunAt: null, lastOkAt: null, state: "never" }],
    countersAvailable: true,
  },
  killSwitch: { on: false, envOn: false },
  ...over,
});

beforeEach(() => {
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({ id: "a", role: "admin", status: "active" } as never);
  loadMetricsPage.mockReset();
  loadMetricsPage.mockResolvedValue(data() as never);
});

const render = async () => renderToStaticMarkup(await MetricsPage());

describe("the metrics page", () => {
  it("checks for an admin itself, before it reads anything", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadMetricsPage).not.toHaveBeenCalled();
  });

  it("is read-only: it has no form and no button", async () => {
    const markup = await render();
    expect(markup).not.toMatch(/<form/);
    expect(markup).not.toMatch(/<button/);
  });

  it("shows the title and the tables", async () => {
    const content = text(await render());
    expect(content).toContain("METRICS");
    expect(content).toContain("LAST 7 DAYS");
    expect(content).toContain("SCHEDULED ROUTES");
    expect(content).toContain("reminders");
  });

  it("says the switch is off, with a link to its page", async () => {
    const markup = await render();
    expect(text(markup)).toMatch(/KILL SWITCH: OFF/);
    expect(markup).toMatch(/<a[^>]*href="\/admin\/kill-switch"/);
  });

  it("says the switch is on when the database holds it on", async () => {
    loadMetricsPage.mockResolvedValue(data({ killSwitch: { on: true, envOn: false } }) as never);
    expect(text(await render())).toMatch(/KILL SWITCH: ON/);
  });

  it("says the switch is on when only the environment holds it on", async () => {
    loadMetricsPage.mockResolvedValue(data({ killSwitch: { on: false, envOn: true } }) as never);
    expect(text(await render())).toMatch(/KILL SWITCH: ON/);
  });
});
