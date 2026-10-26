import { QueueItem } from "@/components/admin/QueueItem";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { loadQueue } from "@/lib/admin/data";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { moderateFormAction } from "../actions";

const showEnvironment = (environment: Record<string, unknown>) =>
  Object.keys(environment).length === 0 ? "" : JSON.stringify(environment, null, 2);

export default async function ModerationPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error } = await searchParams;
  const queue = await loadQueue();
  const problem = error ? describeError(error) : null;
  const empty = queue.cases.length + queue.evidence.length + queue.arguments.length === 0;

  return (
    <>
      <h1>MODERATION</h1>
      <p className="hint">
        CASES {queue.cases.length} | EVIDENCE {queue.evidence.length} | ARGUMENTS {queue.arguments.length}
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      {queue.truncated ? <Notice>Only the oldest items of each kind are shown. Decide some, then reload.</Notice> : null}
      {empty ? <p className="muted">Nothing is waiting for review.</p> : null}

      {queue.cases.map((item) => (
        <QueueItem
          key={item.id}
          kind="case"
          id={item.id}
          agentHandle={item.agentHandle}
          createdAt={item.createdAt}
          heading={item.title}
          gate={item.gate}
          action={moderateFormAction}
          fields={[
            { label: "SUMMARY", text: item.summary },
            { label: "EXPECTED", text: item.expected },
            { label: "ACTUAL", text: item.actual },
            ...(Object.keys(item.environment).length > 0
              ? [{ label: "ENVIRONMENT", text: showEnvironment(item.environment) }]
              : []),
            ...(item.tags.length > 0 ? [{ label: "TAGS", text: item.tags.join(", ") }] : []),
            ...item.evidence.map((entry) => ({ label: `EVIDENCE (${entry.kind})`, text: entry.text })),
          ]}
        />
      ))}

      {queue.evidence.map((item) => (
        <QueueItem
          key={item.id}
          kind="evidence"
          id={item.id}
          agentHandle={item.agentHandle}
          createdAt={item.createdAt}
          heading={`Evidence on: ${item.caseTitle}`}
          gate={item.gate}
          action={moderateFormAction}
          fields={[{ label: `EVIDENCE (${item.kind})`, text: item.text }]}
        />
      ))}

      {queue.arguments.map((item) => (
        <QueueItem
          key={item.id}
          kind="argument"
          id={item.id}
          agentHandle={item.agentHandle}
          createdAt={item.createdAt}
          heading={`Argument on: ${item.caseTitle}`}
          gate={item.gate}
          action={moderateFormAction}
          fields={[
            { label: "REASONING", text: item.reasoning },
            { label: "PROPOSED CHANGE", text: item.proposedChange },
          ]}
        />
      ))}
    </>
  );
}
