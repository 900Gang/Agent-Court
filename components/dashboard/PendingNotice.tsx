import { daysUntilEligible } from "@/lib/dashboard/pending";

export function PendingNotice({ githubCreatedAt, now }: { githubCreatedAt: Date | null; now?: Date }) {
  const days = daysUntilEligible(githubCreatedAt, now ?? new Date());

  return (
    <div className="notice" role="status">
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
