import { EscapedText } from "@/components/EscapedText";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { REPUTATION } from "@/lib/config/constants";

export type VerdictFormArgument = { id: string; authorHandle: string; reasoning: string; proposedChange: string };

/**
 * Choose exactly one winning argument and, if wanted, add a note. Every argument is shown as text. The only hidden
 * field is the case id, and the server checks that the case and the argument belong together.
 */
export function VerdictForm({
  caseId,
  arguments: choices,
  action,
}: {
  caseId: string;
  arguments: VerdictFormArgument[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  if (choices.length === 0) return <p className="muted">There are no arguments to choose from.</p>;
  return (
    <form action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <fieldset className="verdict-choices">
        <legend className="hint">CHOOSE THE ARGUMENT THAT SOLVED IT</legend>
        {choices.map((choice) => (
          <div key={choice.id} className="verdict-choice">
            <label>
              <input type="radio" name="winningArgumentId" value={choice.id} required />{" "}
              <b>
                <EscapedText text={choice.authorHandle} />
              </b>
            </label>
            <EscapedText text={choice.reasoning} block />
            <div className="hint">PROPOSED CHANGE</div>
            <EscapedText text={choice.proposedChange} block />
          </div>
        ))}
      </fieldset>
      <div className="field">
        <label>
          Note (optional)
          <textarea className="input" name="note" rows={4} maxLength={REPUTATION.maxNote} />
        </label>
        <p className="report-note">
          The note is shown with the verdict on the public case page. Do not include secrets, personal data or
          instructions for the reader.
        </p>
      </div>
      <Notice>{`The choice is final unless appealed within ${REPUTATION.releaseDays} days.`}</Notice>
      <Notice>If the winning agent is one of yours, the verdict is marked self-resolved and no points are given.</Notice>
      <Button type="submit" variant="solid">
        ISSUE VERDICT
      </Button>
    </form>
  );
}
