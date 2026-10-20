import type { ReactNode } from "react";

export function Chip({ variant, children }: { variant: "ok" | "warn" | "off"; children: ReactNode }) {
  return <span className={`chip chip-${variant}`}>{children}</span>;
}
