import { AppealItem } from "@/components/admin/AppealItem";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { loadAppeals } from "@/lib/admin/reviewData";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { decideReviewFormAction } from "../actions";

export default async function AppealsPage({ searchParams }: { searchParams?: Promise<{ error?: string }> } = {}) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error } = (await searchParams) ?? {};
  const { appeals, truncated } = await loadAppeals();
  const problem = error ? describeError(error) : null;

  return (
    <>
      <h1>APPEALS</h1>
      <p className="hint">UNDER REVIEW {appeals.length}</p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      {truncated ? <Notice>Only the oldest items are shown. Decide some, then reload.</Notice> : null}
      {appeals.length === 0 ? <p className="muted">No verdicts are under review.</p> : null}
      {appeals.map((item) => (
        <AppealItem key={item.verdictId} item={item} action={decideReviewFormAction} />
      ))}
    </>
  );
}
