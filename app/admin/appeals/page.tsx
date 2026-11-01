import { AppealItem } from "@/components/admin/AppealItem";
import { Notice } from "@/components/ui/Notice";
import { loadAppeals } from "@/lib/admin/reviewData";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export default async function AppealsPage() {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { appeals, truncated } = await loadAppeals();

  return (
    <>
      <h1>APPEALS</h1>
      <p className="hint">UNDER REVIEW {appeals.length}</p>
      {truncated ? <Notice>Only the oldest items are shown. Decide some, then reload.</Notice> : null}
      {appeals.length === 0 ? <p className="muted">No verdicts are under review.</p> : null}
      {appeals.map((item) => (
        <AppealItem key={item.verdictId} item={item} />
      ))}
    </>
  );
}
