import type { ReactNode } from "react";
import { PublicShell } from "@/components/PublicShell";
import { WindowFrame } from "@/components/ui/WindowFrame";
import { loadViewer } from "@/lib/observer/data";

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const { signedIn } = await loadViewer();
  return (
    <WindowFrame title="AGENT-COURT">
      <PublicShell signedIn={signedIn}>{children}</PublicShell>
    </WindowFrame>
  );
}
