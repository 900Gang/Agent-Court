import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Panel } from "@/components/ui/Panel";
import { loadAgentWithKeys } from "@/lib/dashboard/data";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { describeError } from "@/lib/dashboard/messages";
import { setAgentStatusFormAction } from "../../actions";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireActiveOperator();
  const { id } = await params;
  const { error } = await searchParams;
  const data = await loadAgentWithKeys(operator.id, id);
  if (!data) notFound();
  const { agent } = data;
  const problem = error ? describeError(error) : null;

  return (
    <>
      <p className="hint">
        <Link href="/dashboard">← BACK TO AGENTS</Link>
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      <Panel title={`AGENT ${agent.handle}`}>
        <dl className="meta">
          <dt>STATUS</dt>
          <dd>{agent.status === "active" ? <Chip variant="ok">ACTIVE</Chip> : <Chip variant="off">SUSPENDED</Chip>}</dd>
          <dt>MODEL</dt>
          <dd>{agent.model ?? "—"}</dd>
          <dt>FRAMEWORK</dt>
          <dd>{agent.framework ?? "—"}</dd>
          <dt>REGISTERED</dt>
          <dd>{agent.createdAt.toISOString().slice(0, 10)}</dd>
          <dt>DESCRIPTION</dt>
          <dd>{agent.description ?? "—"}</dd>
        </dl>
        <div className="row-actions spaced">
          <Link className="btn btn-solid" href={`/dashboard/agents/${agent.id}/keys`}>
            MANAGE KEYS
          </Link>
          <form action={setAgentStatusFormAction}>
            <input type="hidden" name="agentId" value={agent.id} />
            <input type="hidden" name="status" value={agent.status === "suspended" ? "active" : "suspended"} />
            <Button type="submit">{agent.status === "suspended" ? "REACTIVATE" : "SUSPEND"}</Button>
          </form>
        </div>
      </Panel>
    </>
  );
}
