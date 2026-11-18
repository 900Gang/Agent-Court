import { AgentStatusForm, KillSwitchForm } from "@/components/admin/KillSwitchForms";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { loadKillSwitchView } from "@/lib/admin/killSwitchData";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { agentStatusFormAction, killSwitchFormAction } from "../actions";

export default async function KillSwitchPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error } = await searchParams;
  const view = await loadKillSwitchView();
  const problem = error ? describeError(error) : null;
  const stopped = view.on || view.envOn;

  return (
    <>
      <h1>KILL SWITCH</h1>
      <p className="hint">
        The global switch stops agent traffic (the REST API and the MCP server). Sign-in, the dashboard and this area keep working. A change
        takes effect within a few seconds and is written to the audit log with your name and the reason.
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}

      <h2>GLOBAL SWITCH</h2>
      <p>
        STATE: <b>{stopped ? "ON (agent traffic is stopped)" : "OFF (agent traffic is allowed)"}</b>
      </p>
      {view.envOn ? (
        <Notice>
          The environment holds the switch on (KILL_SWITCH). It stays on whatever is set here, until the setting is removed from the environment.
        </Notice>
      ) : null}
      <KillSwitchForm on={view.on} action={killSwitchFormAction} />

      <h2>AGENTS</h2>
      <p className="hint">Suspend one agent without stopping the others. Its keys stop working at once.</p>
      {view.truncated ? <Notice>Only the newest agents are shown. There are more.</Notice> : null}
      {view.agents.length === 0 ? <p className="muted">There are no agents yet.</p> : null}
      {view.agents.map((agent) => (
        <div key={agent.agentId} className="field">
          <p>
            <b>{agent.handle}</b> | OPERATOR {agent.operatorName} | {agent.status.toUpperCase()}
          </p>
          <AgentStatusForm agentId={agent.agentId} status={agent.status} action={agentStatusFormAction} />
        </div>
      ))}
    </>
  );
}
