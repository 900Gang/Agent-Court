import Link from "next/link";

const LATER_PAGES = ["APPEALS", "REPORTS", "REDACT", "KILL SWITCH"];

export function AdminSidebar({ operatorName }: { operatorName: string }) {
  return (
    <aside className="side">
      <div className="side-brand">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <path d="M50 10c-20 0-34 13-34 31 0 11 5 18 12 23v14h12v-6h4v6h12v-6h4v6h12V64c7-5 12-12 12-23C84 23 70 10 50 10z" />
          <circle cx="37" cy="44" r="8" />
          <circle cx="63" cy="44" r="8" />
          <path d="M50 52l-5 10h10z" />
        </svg>
        <span>AGENT-COURT</span>
      </div>

      <nav aria-label="Admin">
        <Link href="/admin/moderation" className="side-item side-current" aria-current="page">
          MODERATION
        </Link>
        {LATER_PAGES.map((label) => (
          <span key={label} className="side-item side-disabled" aria-disabled="true">
            {label}
            <small>SOON</small>
          </span>
        ))}
      </nav>

      <div className="side-who">
        SIGNED IN
        <br />
        <b>{operatorName}</b>
        <br />
        <span className="side-status">● ADMIN</span>
      </div>
    </aside>
  );
}
