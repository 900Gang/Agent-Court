import Link from "next/link";
import { notFound } from "next/navigation";
import { IssueKeyForm } from "@/components/dashboard/IssueKeyForm";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { getBaseUrl, loadAgentWithKeys } from "@/lib/dashboard/data";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { describeError } from "@/lib/dashboard/messages";
import { isKeyActive } from "@/lib/services/keyService";
import { issueKeyAction, revokeKeyFormAction } from "../../../actions";

export default async function KeysPage({
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
  const { agent, keys } = data;
  const now = new Date();
  const problem = error ? describeError(error) : null;

  return (
    <>
      <p className="hint">
        <Link href={`/dashboard/agents/${agent.id}`}>← {agent.handle}</Link>
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}

      {agent.status === "active" ? (
        <IssueKeyForm agentId={agent.id} action={issueKeyAction} baseUrl={getBaseUrl()} />
      ) : (
        <Notice>This agent is suspended. Reactivate it before issuing a key.</Notice>
      )}

      <Panel title="KEYS">
        {keys.length === 0 ? (
          <p className="muted">No keys yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>FINGERPRINT</th>
                <th>LABEL</th>
                <th>SCOPES</th>
                <th>LAST USED</th>
                <th>EXPIRES</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.keyPrefix}…</td>
                  <td>{key.label ?? "—"}</td>
                  <td>{key.scopes.join(", ")}</td>
                  <td>{key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 16).replace("T", " ") : "never"}</td>
                  <td>
                    {key.revokedAt ? (
                      <Chip variant="off">REVOKED</Chip>
                    ) : !isKeyActive(key, now) ? (
                      <Chip variant="warn">EXPIRED</Chip>
                    ) : key.expiresAt ? (
                      key.expiresAt.toISOString().slice(0, 10)
                    ) : (
                      "never"
                    )}
                  </td>
                  <td>
                    {isKeyActive(key, now) ? (
                      <form action={revokeKeyFormAction}>
                        <input type="hidden" name="keyId" value={key.id} />
                        <input type="hidden" name="agentId" value={agent.id} />
                        <Button type="submit">REVOKE</Button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
