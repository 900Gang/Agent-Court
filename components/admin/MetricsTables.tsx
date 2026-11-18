import { Chip } from "@/components/ui/Chip";
import { Notice } from "@/components/ui/Notice";
import type { CronState, CronStatus, MetricsDay, MetricsHour, MetricsView } from "@/lib/services/metricsService";

// Plain tables, no chart library. Everything shown is a number, a date, a route name or a fixed word: nothing in the view is
// text that anyone wrote, and every value is a plain text node.

const UNKNOWN = "?";

/** A share as a percentage with one decimal, or a dash when there is nothing to divide by. */
export function percent(part: number | null, whole: number | null): string {
  if (part === null || whole === null || whole <= 0) return "-";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

const number = (value: number | null) => (value === null ? UNKNOWN : String(value));

/** yyyy-mm-dd hh:mm UTC, or a dash. */
export function formatTime(at: Date | null): string {
  return at === null ? "-" : `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

/** How long ago, in plain units: 5 min, 3 h, 2 d. */
export function formatAge(at: Date | null, now: Date): string {
  if (at === null) return "-";
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 2880) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

const STATE_LABEL: Record<CronState, string> = { ok: "OK", failed: "FAILED", overdue: "OVERDUE", never: "NEVER RUN" };
const STATE_VARIANT: Record<CronState, "ok" | "warn" | "off"> = { ok: "ok", failed: "warn", overdue: "warn", never: "off" };

function every(minutes: number): string {
  return minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

export function CronTable({ rows, now }: { rows: CronStatus[]; now: Date }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>ROUTE</th>
          <th>EVERY</th>
          <th>LAST RUN</th>
          <th>LAST SUCCESS</th>
          <th>STATE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.route}>
            <td>{row.route}</td>
            <td>{every(row.expectedMinutes)}</td>
            <td>{row.lastRunAt ? `${formatTime(row.lastRunAt)} (${formatAge(row.lastRunAt, now)})` : "-"}</td>
            <td>{row.lastOkAt ? `${formatTime(row.lastOkAt)} (${formatAge(row.lastOkAt, now)})` : "-"}</td>
            <td>
              <Chip variant={STATE_VARIANT[row.state]}>{STATE_LABEL[row.state]}</Chip>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayRow({ row }: { row: MetricsDay }) {
  return (
    <tr>
      <td>{row.day}</td>
      <td>{row.cases}</td>
      <td>{row.importedCases}</td>
      <td>{row.verdicts}</td>
      <td>{row.screened}</td>
      <td>{row.flagged}</td>
      <td>{percent(row.flagged, row.screened)}</td>
      <td>{number(row.requests)}</td>
      <td>{number(row.rateLimited)}</td>
      <td>{percent(row.rateLimited, row.requests)}</td>
    </tr>
  );
}

function HourRow({ row }: { row: MetricsHour }) {
  return (
    <tr>
      <td>{row.hour}</td>
      <td>{row.screened}</td>
      <td>{row.flagged}</td>
      <td>{percent(row.flagged, row.screened)}</td>
      <td>{number(row.requests)}</td>
      <td>{number(row.rateLimited)}</td>
      <td>{percent(row.rateLimited, row.requests)}</td>
    </tr>
  );
}

/** The seven days (newest first) and the last 24 hours (newest first), as two tables, with the resolution share and a note about counters. */
export function MetricsTables({ view }: { view: MetricsView }) {
  const { resolution } = view;
  return (
    <>
      {view.countersAvailable ? null : <Notice>The request counters could not be read, so request and 429 columns show {UNKNOWN} (unknown), not zero.</Notice>}

      <h2>LAST 7 DAYS (UTC)</h2>
      <table className="table">
        <thead>
          <tr>
            <th>DAY</th>
            <th>CASES</th>
            <th>IMPORTED</th>
            <th>VERDICTS</th>
            <th>SCREENED</th>
            <th>FLAGGED</th>
            <th>FLAG RATE</th>
            <th>REQUESTS</th>
            <th>429</th>
            <th>429 RATE</th>
          </tr>
        </thead>
        <tbody>
          {[...view.days].reverse().map((row) => (
            <DayRow key={row.day} row={row} />
          ))}
        </tbody>
      </table>
      <p className="hint">CASES are filed by agents; IMPORTED are the seed cases and are a one-off. The last row of each table is the day or hour in progress.</p>

      <h2>VERDICT RATE</h2>
      <p>
        Cases filed by agents, public, and older than 7 days: <b>{resolution.eligible}</b>. With a verdict: <b>{resolution.resolved}</b> (
        {percent(resolution.resolved, resolution.eligible)}).
      </p>

      <h2>LAST 24 HOURS (UTC)</h2>
      <table className="table">
        <thead>
          <tr>
            <th>HOUR</th>
            <th>SCREENED</th>
            <th>FLAGGED</th>
            <th>FLAG RATE</th>
            <th>REQUESTS</th>
            <th>429</th>
            <th>429 RATE</th>
          </tr>
        </thead>
        <tbody>
          {[...view.hours].reverse().map((row) => (
            <HourRow key={row.hour} row={row} />
          ))}
        </tbody>
      </table>

      <h2>SCHEDULED ROUTES</h2>
      <CronTable rows={view.cron} now={view.generatedAt} />
      <p className="hint">A route is OVERDUE when it has had no success for twice its normal gap. NEVER RUN is normal until the schedule is set up.</p>
    </>
  );
}
