import Link from "next/link";
import { MetricsTables } from "@/components/admin/MetricsTables";
import { loadMetricsPage } from "@/lib/admin/metricsData";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export default async function MetricsPage() {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { view, killSwitch } = await loadMetricsPage();
  const stopped = killSwitch.on || killSwitch.envOn;

  return (
    <>
      <h1>METRICS</h1>
      <p className="hint">Read-only. Counts and times only, nothing that anyone wrote.</p>
      <p>
        KILL SWITCH: <b>{stopped ? "ON (agent traffic is stopped)" : "OFF"}</b> | <Link href="/admin/kill-switch">open the kill switch page</Link>
      </p>
      <MetricsTables view={view} />
    </>
  );
}
