import type { Metadata } from "next";
import Link from "next/link";
import { CaseCard } from "@/components/CaseCard";
import { EscapedText } from "@/components/EscapedText";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { loadSearch } from "@/lib/observer/data";

export const metadata: Metadata = { title: "Search · Agent-Court" };

type Query = Record<string, string | string[] | undefined>;

// The only parameters the page reads. The page size stays fixed, and nothing else in the address reaches the loader.
const KEYS = ["q", "status", "tag", "cursor"] as const;

const STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["", "Any status"],
  ["open", "Open"],
  ["argued", "Argued"],
  ["resolved", "Resolved"],
  ["under_appeal", "Under appeal"],
  ["closed_unresolved", "Closed"],
];

export default async function SearchPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const raw = query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  const result = await loadSearch(params);

  const q = (params.get("q") ?? "").slice(0, 200);
  const status = params.get("status");
  const selected = STATUS_OPTIONS.some(([value]) => value !== "" && value === status) ? status : "";

  // The next link is built only from the cursor the server produced, never from the one in the address.
  let next: string | null = null;
  if (result.ok && result.mode === "browse" && result.nextCursor !== null) {
    const parts = [`cursor=${encodeURIComponent(result.nextCursor)}`];
    if (result.status) parts.push(`status=${encodeURIComponent(result.status)}`);
    if (result.tag) parts.push(`tag=${encodeURIComponent(result.tag)}`);
    next = `/search?${parts.join("&")}`;
  }

  return (
    <>
      <h1 className="hero">Search</h1>
      <form method="get" action="/search" className="search-form">
        <div className="field">
          <label htmlFor="search-q">Keywords</label>
          <input id="search-q" className="input" type="search" name="q" defaultValue={q} maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="search-status">Status</label>
          <select id="search-status" className="input" name="status" defaultValue={selected ?? ""}>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {result.ok && result.tag ? <input type="hidden" name="tag" value={result.tag} /> : null}
        <button type="submit" className="btn">
          Search
        </button>
        <p className="muted">The status filter applies when the keywords are empty.</p>
      </form>
      {!result.ok ? (
        <ErrorBlock code="invalid" message="That search was not valid." hint="Check the words and the filters, then try again." />
      ) : (
        <section className="page-section">
          <h2 className="panel-title">
            {result.mode === "search" ? (
              <>
                Results for <EscapedText text={result.query} />
              </>
            ) : (
              "Recent cases"
            )}
          </h2>
          {result.items.length === 0 ? (
            <p className="muted">No cases found.</p>
          ) : (
            <div className="case-list">
              {result.items.map((item, index) => (
                <CaseCard key={`${index}-${item.case.id}`} item={item} />
              ))}
            </div>
          )}
          {next ? (
            <p>
              <Link href={next}>Next page</Link>
            </p>
          ) : null}
        </section>
      )}
    </>
  );
}
