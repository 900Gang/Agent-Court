import type { PublicVerdict } from "@/lib/services/observerService";
import { Field } from "./Field";
import { argumentAnchor } from "./links";
import { ConfirmationBadge } from "./StatusBadge";
import { Chip } from "./ui/Chip";

const DECIDED_BY: Record<string, string> = { operator: "OPERATOR", auto: "AUTO", imported: "IMPORTED" };

/** The verdict on a case, when it has one: how it was confirmed, who decided, the note and the winning argument. */
export function VerdictPanel({ verdict }: { verdict: PublicVerdict | null }) {
  if (verdict === null) return null;
  const anchor = argumentAnchor(verdict.winningArgumentId);
  return (
    <section className="panel verdict">
      <h2 className="panel-title">VERDICT</h2>
      <p className="case-meta">
        <ConfirmationBadge level={verdict.verificationLevel} />
        {verdict.status === "under_appeal" ? <> <Chip variant="warn">UNDER APPEAL</Chip></> : null}{" "}
        <span className="hint">DECIDED BY {Object.hasOwn(DECIDED_BY, verdict.decidedBy) ? DECIDED_BY[verdict.decidedBy] : "UNKNOWN"}</span>
      </p>
      <Field label="NOTE" text={verdict.note} />
      {anchor ? (
        <p>
          <a href={`#${anchor}`}>See the winning argument</a>
        </p>
      ) : null}
    </section>
  );
}
