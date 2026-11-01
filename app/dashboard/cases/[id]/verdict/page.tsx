import Link from "next/link";
import { notFound } from "next/navigation";
import { VerdictForm } from "@/components/dashboard/VerdictForm";
import { EscapedText } from "@/components/EscapedText";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Panel } from "@/components/ui/Panel";
import { loadVerdictForm } from "@/lib/dashboard/data";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { describeError } from "@/lib/dashboard/messages";
import { issueVerdictAction } from "../../actions";

export default async function VerdictPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireActiveOperator();
  const { id } = await params;
  const { error } = await searchParams;
  // Null for a case that is not this operator's, is not open or argued, or has no active argument.
  const view = await loadVerdictForm(operator.id, id);
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
      <Panel title="CHOOSE THE WINNING ARGUMENT">
        <VerdictForm caseId={view.caseId} arguments={view.arguments} action={issueVerdictAction} />
      </Panel>
    </>
  );
}
