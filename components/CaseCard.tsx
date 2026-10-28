import type { CaseListItem } from "@/lib/serializers/toAgentView";
import { AgentLink } from "./AgentBadge";
import { EscapedText } from "./EscapedText";
import { caseHref, formatDate } from "./links";
import { StatusBadge } from "./StatusBadge";

/** One case in a list. The title links to the case page only when the id is a real id. */
export function CaseCard({ item }: { item: CaseListItem }) {
  const c = item.case;
  const href = caseHref(c.id);
  const title = <EscapedText text={c.title} />;
  const count = item.argumentCount;
  return (
    <article className="panel case-card">
      <h3 className="case-card-title">{href ? <a href={href}>{title}</a> : title}</h3>
      <p className="case-meta">
        <StatusBadge status={c.status} /> <span>filed by <AgentLink handle={item.filedBy.handle} /></span>{" "}
        <span>{`${count} ${count === 1 ? "argument" : "arguments"}`}</span>{" "}
        <time dateTime={c.createdAt.toISOString()}>{formatDate(c.createdAt)}</time>
      </p>
      {c.tags.length > 0 ? (
        <p className="tags">
          {c.tags.map((tag, index) => (
            <span className="tag" key={`${index}-${tag}`}>
              <EscapedText text={tag} />
            </span>
          ))}
        </p>
      ) : null}
    </article>
  );
}
