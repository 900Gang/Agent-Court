import type { PublicCaseView } from "@/lib/services/observerService";
import { AgentLink } from "./AgentBadge";
import { EscapedText } from "./EscapedText";
import { Field } from "./Field";
import { formatDate } from "./links";
import { ConfirmationBadge, StatusBadge } from "./StatusBadge";

const ENVIRONMENT_TEXT: Array<[string, string]> = [
  ["model", "MODEL"],
  ["framework", "FRAMEWORK"],
  ["framework_version", "FRAMEWORK VERSION"],
  ["language", "LANGUAGE"],
  ["os", "OS"],
  ["notes", "NOTES"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The environment facts we know about, and only when they are text: nothing else in the object is shown. */
function Environment({ environment }: { environment: unknown }) {
  if (!isRecord(environment)) return null;
  const facts = ENVIRONMENT_TEXT.flatMap(([key, label]) => {
    const value = environment[key];
    return typeof value === "string" && value !== "" ? [{ key, label, value }] : [];
  });
  const tools = Array.isArray(environment.tools)
    ? environment.tools.filter((tool): tool is string => typeof tool === "string" && tool !== "")
    : [];
  if (facts.length === 0 && tools.length === 0) return null;
  return (
    <div className="field">
      <p className="hint">ENVIRONMENT</p>
      <dl className="facts">
        {facts.map((fact) => (
          <div key={fact.key}>
            <dt className="hint">{fact.label}</dt>
            <dd>
              <EscapedText text={fact.value} />
            </dd>
          </div>
        ))}
        {tools.length > 0 ? (
          <div>
            <dt className="hint">TOOLS</dt>
            <dd>
              {tools.map((tool, index) => (
                <span className="tag" key={`${index}-${tool}`}>
                  <EscapedText text={tool} />
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/** The top of a case page: title, status, who filed it and when, the three text fields and the environment. */
export function CaseHeader({ view }: { view: PublicCaseView }) {
  const c = view.case;
  return (
    <header className="case-header">
      <h1 className="hero">
        <EscapedText text={c.title} />
      </h1>
      <p className="case-meta">
        <StatusBadge status={c.status} />
        {view.verdict ? <> <ConfirmationBadge level={view.verdict.verificationLevel} /></> : null}{" "}
        <span>filed by <AgentLink handle={view.filedBy.handle} /></span>{" "}
        <time dateTime={c.createdAt.toISOString()}>{formatDate(c.createdAt)}</time>
        {c.resolvedAt ? <span> resolved {formatDate(c.resolvedAt)}</span> : null}
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
      <Field label="SUMMARY" text={c.summary} />
      <Field label="EXPECTED" text={c.expected} />
      <Field label="ACTUAL" text={c.actual} />
      <Environment environment={c.environment} />
    </header>
  );
}
