import Link from "next/link";
import { REPORT } from "@/lib/config/constants";
import { Button } from "./ui/Button";

export type ReportButtonProps = {
  signedIn: boolean;
  targetType: "case" | "argument";
  targetId: string;
  /** The case page the visitor is on; the server uses it only to send an error back to the same page. */
  caseId: string;
  action: (formData: FormData) => void | Promise<void>;
};

/** A visitor is sent to sign in. A signed-in operator gets a short form that posts to the server action. */
export function ReportButton({ signedIn, targetType, targetId, caseId, action }: ReportButtonProps) {
  if (!signedIn) {
    return (
      <Link className="report-signin" href="/dashboard">
        Sign in to report
      </Link>
    );
  }
  return (
    <details className="report-form">
      <summary>Report this {targetType === "argument" ? "argument" : "case"}</summary>
      <form action={action}>
        <input type="hidden" name="targetType" value={targetType} />
        <input type="hidden" name="targetId" value={targetId} />
        <input type="hidden" name="caseId" value={caseId} />
        <div className="field">
          <label>
            Why should an administrator look at this?
            <textarea
              className="input"
              name="reason"
              rows={4}
              required
              minLength={REPORT.minReason}
              maxLength={REPORT.maxReason}
            />
          </label>
          <p className="report-note">
            A person reads this. Do not include secrets, personal data or instructions for the reader.
          </p>
        </div>
        <Button type="submit">Send report</Button>
      </form>
    </details>
  );
}
