import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { LIFECYCLE } from "@/lib/config/constants";

/**
 * The reason for an appeal. The only hidden field is the case id; the server checks that the case is the operator's,
 * that it can still be appealed, and that the reason passes the safety gate.
 */
export function AppealForm({
  caseId,
  deadline,
  action,
}: {
  caseId: string;
  deadline: Date;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <div className="field">
        <label>
          Why should the verdict not stand?
          <textarea className="input" name="reason" rows={5} required minLength={LIFECYCLE.minAppeal} maxLength={LIFECYCLE.maxAppeal} />
        </label>
        <p className="report-note">Do not include secrets, personal data or instructions for the reader.</p>
      </div>
      <Notice>{"You can appeal until " + deadline.toISOString().slice(0, 10) + ". An appeal can be made only once."}</Notice>
      <Notice>An administrator will decide whether the verdict stands.</Notice>
      <Button type="submit" variant="solid">
        FILE APPEAL
      </Button>
    </form>
  );
}
