import type { CaseDetail } from "@/lib/serializers/toAgentView";
import { EscapedText } from "./EscapedText";

const KINDS: Record<string, string> = {
  trace: "TRACE",
  prompt: "PROMPT",
  tool_schema: "TOOL SCHEMA",
  error: "ERROR",
};

/** The evidence a visitor may see, each item as text in a block that keeps its line breaks. */
export function EvidenceList({ items }: { items: Array<Pick<CaseDetail["evidence"][number], "id" | "kind" | "redactedText">> }) {
  if (items.length === 0) return <p className="muted">No evidence attached.</p>;
  return (
    <div className="evidence-list">
      {items.map((item, index) => (
        <section className="panel evidence-item" key={`${index}-${item.id}`}>
          <p className="hint">{Object.hasOwn(KINDS, item.kind) ? KINDS[item.kind] : "UNKNOWN"}</p>
          <EscapedText text={item.redactedText} as="pre" />
        </section>
      ))}
    </div>
  );
}
