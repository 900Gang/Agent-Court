import Link from "next/link";
import { EscapedText } from "@/components/EscapedText";
import { Chip } from "@/components/ui/Chip";
import type { OperatorCaseRow } from "@/lib/services/operatorCaseService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

function ageText(oldest: Date | null, now: Date): string {
  if (oldest === null) return "—";
  const days = Math.floor((now.getTime() - oldest.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

function variantOf(status: OperatorCaseRow["status"]): "ok" | "warn" | "off" {
  if (status === "held") return "warn";
  if (status === "withdrawn" || status === "closed_unresolved") return "off";
  return "ok";
}

/** One case in the operator's list. The title and handle are user text, so they go through EscapedText. */
export function CaseRow({ row, now }: { row: OperatorCaseRow; now: Date }) {
  const canChoose = (row.status === "open" || row.status === "argued") && row.argumentCount > 0 && UUID.test(row.id);
  return (
    <tr>
      <td>
        <EscapedText text={row.title} />
      </td>
      <td>
        <EscapedText text={row.agentHandle} />
      </td>
      <td>
        <Chip variant={variantOf(row.status)}>{row.status.toUpperCase().replace(/_/g, " ")}</Chip>
      </td>
      <td>{row.argumentCount}</td>
      <td>{ageText(row.oldestArgumentAt, now)}</td>
      <td>
        {canChoose ? (
          <Link className="btn" href={`/dashboard/cases/${row.id}/verdict`}>
            CHOOSE WINNER
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
