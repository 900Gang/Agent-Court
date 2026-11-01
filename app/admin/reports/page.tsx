import { ReportItem } from "@/components/admin/ReportItem";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { loadReports } from "@/lib/admin/reviewData";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { reportFormAction } from "../actions";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error } = await searchParams;
  const { reports, truncated } = await loadReports();
  const problem = error ? describeError(error) : null;

  return (
    <>
      <h1>REPORTS</h1>
      <p className="hint">OPEN {reports.length}</p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      {truncated ? <Notice>Only the oldest reports are shown. Decide some, then reload.</Notice> : null}
      {reports.length === 0 ? <p className="muted">No open reports.</p> : null}
      {reports.map((item) => (
        <ReportItem key={item.id} item={item} action={reportFormAction} />
      ))}
    </>
  );
}
