import "server-only";
import { getDb } from "@/db/client";
import { getServerEnv } from "@/lib/config/env";
import { getCounters } from "@/lib/metrics/server";
import { getKillSwitch } from "@/lib/services/killSwitchService";
import { loadMetrics, type MetricsView } from "@/lib/services/metricsService";

export type MetricsPageData = {
  view: MetricsView;
  /** The database value of the kill switch, and whether the environment holds it on. */
  killSwitch: { on: boolean; envOn: boolean };
};

/** Everything /admin/metrics shows, from the real database and counters. Pages go through here instead of importing the database. */
export async function loadMetricsPage(): Promise<MetricsPageData> {
  const db = getDb();
  const [view, on] = await Promise.all([loadMetrics(db, getCounters(), new Date()), getKillSwitch(db)]);
  return { view, killSwitch: { on, envOn: getServerEnv().killSwitch } };
}
