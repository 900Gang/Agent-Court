import { boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tstz } from "./columns";

// One row per run of a scheduled job (N10). It holds the route name, the times, whether the run succeeded and the counts
// the job reported (numbers and booleans only), never a message or any text. Written by lib/http/cronRun.ts and read by
// the metrics page and the alert check (`check:routes` rule 9). Only the newest rows are kept.
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: id(),
    route: text("route").notNull(),
    startedAt: tstz("started_at").notNull(),
    finishedAt: tstz("finished_at").notNull(),
    ok: boolean("ok").notNull(),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("cron_runs_route_finished_idx").on(t.route, t.finishedAt)],
);

export type CronRun = typeof cronRuns.$inferSelect;
