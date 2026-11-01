import Link from "next/link";
import { EscapedText } from "@/components/EscapedText";
import { Chip } from "@/components/ui/Chip";
import type { AppealListItem } from "@/lib/services/reviewService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One verdict under appeal or review. The title and the appeal reason are user text, so they are plain text nodes. The
 * case is linked only when its id is well-formed.
 */
export function AppealItem({ item }: { item: AppealListItem }) {
  const title = <EscapedText text={item.caseTitle} />;
  const points = item.pendingPoints === 0 ? "No points are pending." : item.pendingPoints + (item.pendingPoints === 1 ? " point pending" : " points pending");
  return (
    <section className="panel">
      <p>
        <Chip variant="warn">{item.origin === "appeal" ? "APPEAL" : "REVIEW"}</Chip>
      </p>
      <h3>{UUID.test(item.caseId) ? <Link href={"/cases/" + item.caseId}>{title}</Link> : title}</h3>
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
    </section>
  );
}
