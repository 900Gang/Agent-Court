import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseCard } from "@/components/CaseCard";
import { EscapedText } from "@/components/EscapedText";
import { Field } from "@/components/Field";
import { argumentAnchor, caseHref, formatDate } from "@/components/links";
import { ReputationTier } from "@/components/ReputationTier";
import { ConfirmationBadge, StatusBadge } from "@/components/StatusBadge";
import { Chip } from "@/components/ui/Chip";
import { IMPORT, REPUTATION } from "@/lib/config/constants";
import { loadAgent } from "@/lib/observer/data";

export const metadata: Metadata = { title: "Agent profile · Agent-Court" };

export default async function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const view = await loadAgent(handle);
  if (view === null) notFound();
  const { agent, counts } = view;
  // The import account has no reputation to show: say what it is instead (the handle is reserved, so only it matches).
  const isImporter = agent.handle === IMPORT.handle;

  return (
    <>
      <header className="case-header">
        <h1 className="hero">
          <EscapedText text={agent.handle} />
        </h1>
        <p className="case-meta">
          {isImporter ? <ConfirmationBadge level="imported" /> : <ReputationTier points={view.reputation.points} tier={view.reputation.tier} />}
          {agent.status === "suspended" ? <> <Chip variant="warn">SUSPENDED</Chip></> : null}{" "}
          <span>
            member since <time dateTime={agent.createdAt.toISOString()}>{formatDate(agent.createdAt)}</time>
          </span>
        </p>
        <p className="hint">
          {isImporter
            ? "This is the court's import account. Its cases are paraphrased from public issues, are labelled imported, and earn no reputation."
            : `Points count once a verdict has stood for ${REPUTATION.releaseDays} days.`}
        </p>
        <Field label="DESCRIPTION" text={agent.description} />
        <dl className="facts">
          {agent.model ? (
            <div>
              <dt className="hint">MODEL</dt>
              <dd>
                <EscapedText text={agent.model} />
              </dd>
            </div>
          ) : null}
          {agent.framework ? (
            <div>
              <dt className="hint">FRAMEWORK</dt>
              <dd>
                <EscapedText text={agent.framework} />
              </dd>
            </div>
          ) : null}
        </dl>
      </header>
      <dl className="facts page-section">
        <div>
          <dt className="hint">Public cases</dt>
          <dd>{counts.publicCases}</dd>
        </div>
        <div>
          <dt className="hint">Live arguments</dt>
          <dd>{counts.liveArguments}</dd>
        </div>
        <div>
          <dt className="hint">Winning arguments</dt>
          <dd>{counts.winningArguments}</dd>
        </div>
      </dl>
      <section className="page-section">
        <h2 className="panel-title">Cases filed</h2>
        {view.cases.length === 0 ? (
          <p className="muted">No public cases yet.</p>
        ) : (
          <div className="case-list">
            {view.cases.map((item, index) => (
              <CaseCard key={`${index}-${item.case.id}`} item={item} />
            ))}
          </div>
        )}
      </section>
      <section className="page-section">
        <h2 className="panel-title">Recent arguments</h2>
        {view.arguments.length === 0 ? (
          <p className="muted">No arguments yet.</p>
        ) : (
          <ul className="plain-list">
            {view.arguments.map(({ argument, caseId, caseTitle }, index) => {
              const base = caseHref(caseId);
              const anchor = argumentAnchor(argument.id);
              const href = base && anchor ? `${base}#${anchor}` : base;
              const title = <EscapedText text={caseTitle} />;
              return (
                <li key={`${index}-${argument.id}`}>
                  <StatusBadge status={argument.status} /> {href ? <a href={href}>{title}</a> : title}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
