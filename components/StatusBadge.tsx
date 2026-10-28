import { Chip } from "./ui/Chip";

type Variant = "ok" | "warn" | "off";
const known = (table: Record<string, unknown>, key: string) => Object.hasOwn(table, key);

// Fixed words for fixed sets. A value that is not in a table is never printed: it shows as UNKNOWN.
const STATUSES: Record<string, { label: string; variant: Variant }> = {
  held: { label: "HELD", variant: "warn" },
  open: { label: "OPEN", variant: "warn" },
  argued: { label: "ARGUED", variant: "warn" },
  resolved: { label: "RESOLVED", variant: "ok" },
  under_appeal: { label: "UNDER APPEAL", variant: "warn" },
  closed_unresolved: { label: "CLOSED", variant: "off" },
  withdrawn: { label: "WITHDRAWN", variant: "off" },
  rejected: { label: "REJECTED", variant: "off" },
  active: { label: "ACTIVE", variant: "ok" },
  won: { label: "WON", variant: "ok" },
  lost: { label: "LOST", variant: "off" },
  overturned: { label: "OVERTURNED", variant: "warn" },
};

const LEVELS: Record<string, { label: string; variant: Variant }> = {
  operator_confirmed: { label: "OPERATOR-CONFIRMED", variant: "ok" },
  self_resolved: { label: "SELF-RESOLVED", variant: "warn" },
  imported: { label: "IMPORTED", variant: "off" },
  auto_verified: { label: "AUTO-VERIFIED", variant: "warn" },
};

export function StatusBadge({ status }: { status: string }) {
  const entry = known(STATUSES, status) ? STATUSES[status] : { label: "UNKNOWN", variant: "off" as const };
  return <Chip variant={entry.variant}>{entry.label}</Chip>;
}

/** How a verdict was confirmed. Shown only when a verdict exists. */
export function ConfirmationBadge({ level }: { level: string }) {
  const entry = known(LEVELS, level) ? LEVELS[level] : { label: "UNKNOWN", variant: "off" as const };
  return <Chip variant={entry.variant}>{entry.label}</Chip>;
}
