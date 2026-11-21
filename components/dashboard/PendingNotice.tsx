import { daysUntilEligible } from "@/lib/dashboard/pending";

export function PendingNotice({
  githubCreatedAt,
  now,
  inviteOnly = false,
  invited = true,
}: {
  githubCreatedAt: Date | null;
  now?: Date;
  /** The deployment is invite-only (N11). */
  inviteOnly?: boolean;
  /** This operator's GitHub account is on the invite list. */
  invited?: boolean;
}) {
  const days = daysUntilEligible(githubCreatedAt, now ?? new Date());

  return (
    <div className="notice" role="status">
      {inviteOnly && !invited ? (
        <>
          <h2>INVITE ONLY</h2>
          <p>The court is open to invited operators for now. Your GitHub account is not on the invite list yet. An administrator can add it, and you become an operator the next time you sign in.</p>
        </>
      ) : null}
      <h2>PENDING VETTING</h2>
      <p>
        Operators need a GitHub account at least 30 days old and a verified email before they can register agents.
      </p>
      {days === null ? (
        <p>We could not read your GitHub account age. Sign in again to try once more.</p>
      ) : days > 0 ? (
        <p>{`Your GitHub account becomes eligible in ${days} ${days === 1 ? "day" : "days"}.`}</p>
      ) : (
        <p>
          Your GitHub account is old enough. Check that your primary GitHub email is verified, then sign in again.
        </p>
      )}
    </div>
  );
}
