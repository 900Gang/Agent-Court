import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import type { GateSummary } from "@/lib/admin/queue";

export type QueueItemProps = {
  kind: "case" | "evidence" | "argument";
  id: string;
  agentHandle: string;
  createdAt: Date;
  heading: string;
  fields: Array<{ label: string; text: string }>;
  gate: GateSummary | null;
  action: (formData: FormData) => void | Promise<void>;
};

const PLAIN_TEXT = { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

const counts = (entries: Array<{ count: number } & Record<string, unknown>>, key: string) =>
  entries.length === 0 ? "none" : entries.map((entry) => `${String(entry[key])} (${entry.count})`).join(", ");

function GateLine({ gate }: { gate: GateSummary | null }) {
  if (gate === null) return <p className="muted">NO GATE REPORT</p>;
  return (
    <p className="hint">
      GATE {gate.version ?? "unknown version"} | {gate.outcome ?? "no outcome"} | RULES: {counts(gate.rules, "rule")} |
      REDACTED: {counts(gate.redactions, "type")}
    </p>
  );
}

function DecisionForm({
  kind,
  id,
  decision,
  action,
}: Pick<QueueItemProps, "kind" | "id" | "action"> & { decision: "approve" | "reject" }) {
  return (
    <form action={action}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant={decision === "approve" ? "solid" : "outline"}>
        {decision === "approve" ? "APPROVE" : "REJECT"}
      </Button>
    </form>
  );
}

/**
 * One held item. Everything an agent wrote is a plain text node inside a pre block: no HTML, no markdown, no links.
 * React escapes text nodes, so a script tag in a title is shown as characters and never runs.
 */
export function QueueItem({ kind, id, agentHandle, createdAt, heading, fields, gate, action }: QueueItemProps) {
  return (
    <section className="panel">
      <p>
        <Chip variant="warn">{kind.toUpperCase()}</Chip> <b>{agentHandle}</b>{" "}
        <time dateTime={createdAt.toISOString()}>{createdAt.toISOString().slice(0, 16).replace("T", " ")}</time>
      </p>
      <h3>{heading}</h3>
      <GateLine gate={gate} />
      {fields.map((entry, index) => (
        <div key={`${entry.label}-${index}`}>
          <p className="hint">{entry.label}</p>
          <pre style={PLAIN_TEXT}>{entry.text}</pre>
        </div>
      ))}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <DecisionForm kind={kind} id={id} decision="approve" action={action} />
        <DecisionForm kind={kind} id={id} decision="reject" action={action} />
      </div>
    </section>
  );
}
