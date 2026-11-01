import Link from "next/link";
import { EscapedText } from "@/components/EscapedText";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import type { AppealListItem } from "@/lib/services/reviewService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Action = (formData: FormData) => void | Promise<void>;

function DecisionForm({ caseId, decision, label, action, solid }: { caseId: string; decision: string; label: string; action: Action; solid?: boolean }) {
  return (
    <form action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant={solid ? "solid" : "outline"}>
        {label}
      </Button>
    </form>
  );
}

/**
 * One verdict under appeal or review. The title and the appeal reason are user text, so they are plain text nodes. The
 * case is linked, and the decision forms are offered, only when its id is well-formed.
 */
export function AppealItem({ item, action }: { item: AppealListItem; action?: Action }) {
  const title = <EscapedText text={item.caseTitle} />;
  const validId = UUID.test(item.caseId);
  const points = item.pendingPoints === 0 ? "No points are pending." : item.pendingPoints + (item.pendingPoints === 1 ? " point pending" : " points pending");
  return (
    <section className="panel">
      <p>
        <Chip variant="warn">{item.origin === "appeal" ? "APPEAL" : "REVIEW"}</Chip>
      </p>
      <h3>{validId ? <Link href={"/cases/" + item.caseId}>{title}</Link> : title}</h3>
      <p className="hint">{"The verdict was issued on " + item.verdictAt.toISOString().slice(0, 10) + "."}</p>
      {item.origin === "appeal" ? (
        <>
          <p className="hint">REASON</p>
          <EscapedText text={item.appealReason} as="pre" />
        </>
      ) : (
        <p className="muted">Opened by an administrator from a report.</p>
      )}
      <p className="muted">{points}</p>
      {action && validId ? (
        <>
          <p className="hint">Upholding keeps the verdict and its points.</p>
          <p className="hint">Overturning removes the verdict, takes back its points and lets a new verdict follow.</p>
          <div className="row-actions">
            <DecisionForm caseId={item.caseId} decision="uphold" label="UPHOLD" action={action} />
            <DecisionForm caseId={item.caseId} decision="overturn" label="OVERTURN" action={action} solid />
          </div>
        </>
      ) : null}
    </section>
  );
}
