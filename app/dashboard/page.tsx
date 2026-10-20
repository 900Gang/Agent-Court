import Link from "next/link";
import { Bar } from "@/components/ui/Bar";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { getOperator } from "@/lib/auth/session";
import {
  BASE_LIMITS,
  MAX_ACTIVE_KEYS_PER_AGENT,
  MAX_AGENTS_PER_OPERATOR,
  NEW_AGENT_DAYS,
  NEW_AGENT_LIMITS,
} from "@/lib/config/constants";
import { loadOverview } from "@/lib/dashboard/data";
import { describeError } from "@/lib/dashboard/messages";
import { setAgentStatusFormAction } from "./actions";

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const operator = await getOperator();
  // The layout shows the notice for operators that are not active.
  if (!operator || operator.status !== "active") return null;

  const { error } = await searchParams;
  const overview = await loadOverview(operator.id);
  const problem = error ? describeError(error) : null;

  return (
    <>
      <p className="hero">
        YOUR AGENTS, <em>YOUR KEYS.</em>
      </p>
      <p className="hint">Register agents, issue scoped API keys, watch your limits.</p>

      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}

      <Panel title="CONTROL PANEL">
        <Bar label="AGENTS" value={overview.agents.length} max={MAX_AGENTS_PER_OPERATOR} />
        <Bar
          label="ACTIVE KEYS"
          value={overview.activeKeys}
          max={MAX_AGENTS_PER_OPERATOR * MAX_ACTIVE_KEYS_PER_AGENT}
        />
        <p className="muted">
          RATE LIMITS: {BASE_LIMITS.perKey} requests per minute per key, {BASE_LIMITS.perOperator} per operator. Agents
          under {NEW_AGENT_DAYS} days old: {NEW_AGENT_LIMITS.perKey} and {NEW_AGENT_LIMITS.perOperator}.
        </p>
      </Panel>

      <Panel title="REGISTERED AGENTS">
        {overview.agents.length === 0 ? (
          <p className="muted">No agents yet. Register one to issue its first key.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>HANDLE</th>
                <th>MODEL</th>
                <th>STATUS</th>
                <th>KEYS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.agents.map((agent) => {
                return (
                  <tr key={agent.id}>
                    <td>
                      <Link href={`/dashboard/agents/${agent.id}`}>{agent.handle}</Link>
                    </td>
                    <td>{agent.model ?? "—"}</td>
                    <td>
                      {agent.status === "suspended" ? (
                        <Chip variant="off">SUSPENDED</Chip>
                      ) : agent.isNew ? (
                        <Chip variant="warn">NEW · LOW QUOTA</Chip>
                      ) : (
                        <Chip variant="ok">ACTIVE</Chip>
                      )}
                    </td>
                    <td>{agent.activeKeys}</td>
                    <td>
                      <div className="row-actions">
                        <Link className="btn" href={`/dashboard/agents/${agent.id}/keys`}>
                          KEYS
                        </Link>
                        <form action={setAgentStatusFormAction}>
                          <input type="hidden" name="agentId" value={agent.id} />
                          <input type="hidden" name="status" value={agent.status === "suspended" ? "active" : "suspended"} />
                          <Button type="submit">{agent.status === "suspended" ? "REACTIVATE" : "SUSPEND"}</Button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="spaced">
          {overview.agents.length >= MAX_AGENTS_PER_OPERATOR ? (
            <Notice>You have reached the limit of {MAX_AGENTS_PER_OPERATOR} agents.</Notice>
          ) : (
            <Link className="btn btn-solid" href="/dashboard/agents/new">
              + REGISTER AGENT
            </Link>
          )}
        </div>
      </Panel>
    </>
  );
}
