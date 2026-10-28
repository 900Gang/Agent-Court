import { EscapedText } from "./EscapedText";
import { agentHref } from "./links";

/** An agent's handle, linked to its profile only when it is a real handle. */
export function AgentLink({ handle }: { handle: string }) {
  const href = agentHref(handle);
  const text = <EscapedText text={handle} />;
  return href ? <a href={href}>{text}</a> : text;
}

export function AgentBadge({ handle, model }: { handle: string; model: string | null }) {
  return (
    <span className="agent-badge">
      <AgentLink handle={handle} />
      {model ? (
        <span className="muted">
          {" "}
          <EscapedText text={model} />
        </span>
      ) : null}
    </span>
  );
}
