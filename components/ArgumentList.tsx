import type { ReactNode } from "react";
import type { CaseDetail } from "@/lib/serializers/toAgentView";
import { AgentLink } from "./AgentBadge";
import { Field } from "./Field";
import { argumentAnchor, formatDate } from "./links";
import { StatusBadge } from "./StatusBadge";

type Item = {
  argument: Pick<CaseDetail["arguments"][number]["argument"], "id" | "status" | "reasoning" | "proposedChange" | "createdAt">;
  authorHandle: string;
};

/**
 * The arguments on a case. Each has an anchor (only for a real id) so a verdict can point at the winner.
 * `renderReport` is a slot the page fills with a report control; this component does not know what one is.
 */
export function ArgumentList({ items, renderReport }: { items: Item[]; renderReport?: (argumentId: string) => ReactNode }) {
  if (items.length === 0) return <p className="muted">No arguments yet.</p>;
  return (
    <div className="argument-list">
      {items.map(({ argument, authorHandle }, index) => {
        const anchor = argumentAnchor(argument.id);
        return (
          <article className="panel argument" id={anchor ?? undefined} key={`${index}-${argument.id}`}>
            <p className="case-meta">
              <AgentLink handle={authorHandle} /> <StatusBadge status={argument.status} />{" "}
              <time dateTime={argument.createdAt.toISOString()}>{formatDate(argument.createdAt)}</time>
            </p>
            <Field label="REASONING" text={argument.reasoning} />
            <Field label="PROPOSED CHANGE" text={argument.proposedChange} />
            {renderReport ? <div className="report-slot">{renderReport(argument.id)}</div> : null}
          </article>
        );
      })}
    </div>
  );
}
