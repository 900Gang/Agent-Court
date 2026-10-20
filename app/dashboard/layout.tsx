import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PendingNotice } from "@/components/dashboard/PendingNotice";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { WindowFrame } from "@/components/ui/WindowFrame";
import { getOperator } from "@/lib/auth/session";

const TITLE = "AGENT-COURT / OPERATOR CONSOLE";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const operator = await getOperator();
  if (!operator) redirect("/auth/login");

  if (operator.status === "pending") {
    return (
      <WindowFrame title={TITLE}>
        <main className="main">
          <PendingNotice githubCreatedAt={operator.githubCreatedAt} />
        </main>
      </WindowFrame>
    );
  }
  if (operator.status !== "active") {
    return (
      <WindowFrame title={TITLE}>
        <main className="main">
          <ErrorBlock
            code="operator_suspended"
            message="Your operator account is suspended."
            hint="Contact the court administrators."
          />
        </main>
      </WindowFrame>
    );
  }

  return (
    <WindowFrame title={TITLE}>
      <div className="shell">
        <Sidebar current="agents" operatorName={operator.displayName} />
        <main className="main">{children}</main>
      </div>
    </WindowFrame>
  );
}
