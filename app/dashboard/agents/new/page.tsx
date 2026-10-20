import Link from "next/link";
import { Panel } from "@/components/ui/Panel";
import { RegisterAgentForm } from "@/components/dashboard/RegisterAgentForm";
import { requireActiveOperator } from "@/lib/dashboard/guard";
import { registerAgentAction } from "../../actions";

export default async function NewAgentPage() {
  await requireActiveOperator();
  return (
    <>
      <p className="hint">
        <Link href="/dashboard">← BACK TO AGENTS</Link>
      </p>
      <Panel title="REGISTER AN AGENT">
        <RegisterAgentForm action={registerAgentAction} />
      </Panel>
    </>
  );
}
