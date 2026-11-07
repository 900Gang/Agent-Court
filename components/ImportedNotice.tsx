import { licenseOf, parseGithubUrl, repositoryOf } from "@/lib/import/sources";
import { EscapedText } from "./EscapedText";
import { ConfirmationBadge } from "./StatusBadge";

// A link is made only from a GitHub link of the right kind (an issue for the source, a pull request for the fix) that the
// strict parser accepts. Anything else is shown as plain text and marked as not a link, so a stored string can never
// become an address. The repository comes from the validated link, never from stored text.
function usable(value: unknown, kind: "issue" | "pull"): string | null {
  const ref = parseGithubUrl(value);
  return typeof value === "string" && ref !== null && ref.kind === kind ? value : null;
}

const asText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function OutsideLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}
/** What an imported case is: where it came from, under which licence, and that this court has not verified it. */
export function ImportedNotice({ sourceUrl, license, fixUrl }: { sourceUrl: unknown; license: unknown; fixUrl: unknown }) {
  const issue = usable(sourceUrl, "issue");
  const fix = usable(fixUrl, "pull");
  const repository = issue === null ? null : repositoryOf(issue);
  const stored = asText(license);
  const shownLicense = stored ?? (repository === null ? null : licenseOf(repository));
  const badSource = issue === null ? asText(sourceUrl) : null;
  const badFix = fix === null ? asText(fixUrl) : null;
  return (
    <section className="panel imported-notice">
      <p className="case-meta">
        <ConfirmationBadge level="imported" />
      </p>
      <p>
        {repository === null ? "Imported from a public issue" : `Imported from ${repository}`}
        {shownLicense === null ? null : (
          <>
            {" (licence "}
            <EscapedText text={shownLicense} />
            {")"}
          </>
        )}
        {". Paraphrased from a public issue; not verified by this court. Imported cases earn no reputation."}
      </p>
      {issue !== null || fix !== null ? (
        <p>
          {issue === null ? null : <OutsideLink href={issue}>Original issue</OutsideLink>}
          {issue !== null && fix !== null ? " · " : null}
          {fix === null ? null : <OutsideLink href={fix}>Merged fix</OutsideLink>}
        </p>
      ) : null}
      {badSource === null ? null : (
        <p className="hint">
          {"Source (not a link): "}
          <EscapedText text={badSource} />
        </p>
      )}
      {badFix === null ? null : (
        <p className="hint">
          {"Fix (not a link): "}
          <EscapedText text={badFix} />
        </p>
      )}
    </section>
  );
}