import type { ReactNode } from "react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { WindowFrame } from "@/components/ui/WindowFrame";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// Every page under /admin is behind this check. Anyone who is not an active admin gets the not-found page.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operator = await requireAdmin();
  return (
    <WindowFrame title="AGENT-COURT / ADMIN">
      <div className="shell">
        <AdminSidebar operatorName={operator.displayName} />
        <main className="main">{children}</main>
      </div>
    </WindowFrame>
  );
}
