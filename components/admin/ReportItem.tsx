import Link from "next/link";
import { EscapedText } from "@/components/EscapedText";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import type { ReportListItem } from "@/lib/services/reviewService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Action = (formData: FormData) => void | Promise<void>;

function DecisionForm({ id, decision, label, action, solid }: { id: string; decision: string; label: string; action: Action; solid?: boolean }) {
  return (
    <form action={action}>
      <input type="hidden" name="reportId" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant={solid ? "solid" : "outline"}>
        {label}
      </Button>
    </form>
  );
}

/**
 * One open report. The reason and the case title are user text, so they are plain text nodes: no HTML, no markdown. The
 * case is linked only when its id is well-formed. A review is offered only when one can be opened.
 */
export function ReportItem({ item, action }: { item: ReportListItem; action: Action }) {
  const title = item.caseTitle === null ? null : <EscapedText text={item.caseTitle} />;
  return (
    <section className="panel">
      <p>
        <Chip variant="warn">{item.targetType.toUpperCase()}</Chip>{" "}
        <time dateTime={item.createdAt.toISOString()}>{item.createdAt.toISOString().slice(0, 16).replace("T", " ")}</time>
      </p>
      {item.caseId === null || title === null ? (
        <p className="muted">The reported item no longer exists.</p>
      ) : (
        <h3>{UUID.test(item.caseId) ? <Link href={"/cases/" + item.caseId}>{title}</Link> : title}</h3>
      )}
      {item.caseStatus !== null ? (
        <p className="hint">
          CASE STATE <Chip variant="off">{item.caseStatus.toUpperCase().replace(/_/g, " ")}</Chip>
        </p>
      ) : null}
      <p className="hint">REASON</p>
      <EscapedText text={item.reason} as="pre" />
      <div className="row-actions">
        <DecisionForm id={item.id} decision="dismiss" label="DISMISS" action={action} />
        <DecisionForm id={item.id} decision="reviewed" label="MARK REVIEWED" action={action} />
        {item.canOpenReview ? <DecisionForm id={item.id} decision="open_review" label="OPEN REVIEW" action={action} solid /> : null}
      </div>
    </section>
  );
}
