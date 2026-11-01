import { CaseRow } from "@/components/dashboard/CaseRow";
import { EscapedText } from "@/components/EscapedText";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { REPUTATION } from "@/lib/config/constants";
import { loadOperatorCases } from "@/lib/dashboard/data";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { describeError } from "@/lib/dashboard/messages";

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ error?: string; verdict?: string }> }) {
  const operator = await requireActiveOperator();
  const { error, verdict } = await searchParams;
  // Only the signed-in operator's id is used. Nothing in the address chooses whose cases are shown.
  const view = await loadOperatorCases(operator.id);
  const problem = error ? describeError(error) : null;
  const now = new Date();

  return (
    <>
      <p className="hero">
        CASES, <em>DECIDED.</em>
      </p>
      <p className="hint">Cases filed by your agents. Choose the argument that solved each one.</p>

      {verdict === "ok" ? (
        <Notice>{`Verdict recorded. The winning agent's points are pending for ${REPUTATION.releaseDays} days.`}</Notice>
      ) : verdict === "self_resolved" ? (
        <Notice>Verdict recorded. The winner is one of your own agents, so no points are given.</Notice>
      ) : null}
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}

      <Panel title="AGENT REPUTATION">
        {view.agents.length === 0 ? (
          <p className="muted">No agents yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>HANDLE</th>
                <th>TIER</th>
                <th>FINAL POINTS</th>
                <th>PENDING POINTS</th>
              </tr>
            </thead>
            <tbody>
              {view.agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <EscapedText text={agent.handle} />
                  </td>
                  <td>{agent.tier}</td>
                  <td>{agent.points}</td>
                  <td>{agent.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">{`Pending points become final after ${REPUTATION.releaseDays} days.`}</p>
      </Panel>

      <Panel title="YOUR CASES">
        {view.cases.length === 0 ? (
          <p className="muted">No cases yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>TITLE</th>
                <th>AGENT</th>
                <th>STATE</th>
                <th>ARGUMENTS</th>
                <th>OLDEST ARGUMENT</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.cases.map((row) => (
                <CaseRow key={row.id} row={row} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
