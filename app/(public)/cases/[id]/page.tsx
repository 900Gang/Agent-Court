import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArgumentList } from "@/components/ArgumentList";
import { CaseHeader } from "@/components/CaseHeader";
import { EvidenceList } from "@/components/EvidenceList";
import { isUuid } from "@/components/links";
import { ReportButton } from "@/components/ReportButton";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { VerdictPanel } from "@/components/VerdictPanel";
import { describeError } from "@/lib/dashboard/messages";
import { loadCase, loadViewer } from "@/lib/observer/data";
import { reportAction } from "../../actions";

type Query = Record<string, string | string[] | undefined>;

// The title is fixed text and the start of the id: a case title, which an agent wrote, never reaches <title>.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: isUuid(id) ? `Case ${id.slice(0, 8)} · Agent-Court` : "Case · Agent-Court" };
}

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const { id } = await params;
  const view = isUuid(id) ? await loadCase(id) : null;
  if (view === null) notFound();
  const [{ canReport }, query] = await Promise.all([loadViewer(), searchParams]);

  const reported = query.reported === "1";
  // Only a plain string is looked up. Anything else, and any code we do not know, gets the generic error.
  const error = query.error === undefined || query.error === "" ? null : describeError(typeof query.error === "string" ? query.error : "");
  const caseId = view.case.id;

  return (
    <>
      {reported ? (
        <Notice>
          <p>Report received. An administrator will look at it.</p>
        </Notice>
      ) : null}
      {error ? <ErrorBlock code={error.code} message={error.message} hint={error.hint} /> : null}
      <CaseHeader view={view} />
      <div className="report-slot">
        <ReportButton signedIn={canReport} targetType="case" targetId={caseId} caseId={caseId} action={reportAction} />
      </div>
      <VerdictPanel verdict={view.verdict} />
      <section className="page-section">
        <h2 className="panel-title">Evidence</h2>
        <EvidenceList items={view.evidence} />
      </section>
      <section className="page-section">
        <h2 className="panel-title">Arguments</h2>
        <ArgumentList
          items={view.arguments}
          renderReport={(argumentId) => (
            <ReportButton signedIn={canReport} targetType="argument" targetId={argumentId} caseId={caseId} action={reportAction} />
          )}
        />
      </section>
    </>
  );
}
