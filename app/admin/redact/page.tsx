import { RedactForm } from "@/components/admin/RedactForm";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { redactFormAction } from "../actions";

export default async function RedactPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error, done } = await searchParams;
  const problem = error ? describeError(error) : null;
  // Only a short run of digits is ever shown back; anything else in the address is ignored.
  const removed = typeof done === "string" && /^\d{1,6}$/.test(done) ? Number(done) : null;

  return (
    <>
      <h1>REDACT</h1>
      <p className="hint">Remove text from a case, an evidence item or an argument. The record keeps who did it and how much, never the text.</p>
      {removed !== null ? <Notice>{"Redaction applied: " + removed + (removed === 1 ? " character" : " characters") + " removed."}</Notice> : null}
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      <RedactForm action={redactFormAction} />
    </>
  );
}
