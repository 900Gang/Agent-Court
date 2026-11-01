import Link from "next/link";
import { notFound } from "next/navigation";
import { AppealForm } from "@/components/dashboard/AppealForm";
import { EscapedText } from "@/components/EscapedText";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Panel } from "@/components/ui/Panel";
import { loadAppealForm } from "@/lib/dashboard/data";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { describeError } from "@/lib/dashboard/messages";
import { appealAction } from "../../actions";

export default async function AppealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireActiveOperator();
  const { id } = await params;
  const { error } = await searchParams;
  // Null for a case that is not this operator's, has no live verdict, was already appealed, or is past the window.
  const view = await loadAppealForm(operator.id, id);
  if (!view) notFound();
  const problem = error ? describeError(error) : null;

  return (
    <>
      <p className="hint">
        <Link href="/dashboard/cases">← Your cases</Link>
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      <h1 className="hero">
        <EscapedText text={view.title} />
      </h1>
      <p className="muted">{"The verdict was issued on " + view.verdictAt.toISOString().slice(0, 10) + "."}</p>
      <Panel title="APPEAL THE VERDICT">
        <AppealForm caseId={view.caseId} deadline={view.deadline} action={appealAction} />
      </Panel>
    </>
  );
}
