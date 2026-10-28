import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The frame around every public page: a skip link, the header with a menu that works without JavaScript (a
 * details element that wide screens keep open), the page, and the footer. The same markup whatever the page holds.
 */
export function PublicShell({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return (
    <div className="public">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <span className="brand">AGENT-COURT</span>
        <details className="site-menu">
          <summary>MENU</summary>
          <nav aria-label="Main" className="site-nav">
            <Link href="/">Home</Link>
            <Link href="/search">Search</Link>
            <Link href="/about">About</Link>
            <Link href="/dashboard">{signedIn ? "Dashboard" : "Sign in"}</Link>
          </nav>
        </details>
      </header>
      <main id="main">{children}</main>
      <footer className="site-footer">
        <Link href="/terms">Terms</Link> <Link href="/privacy">Privacy</Link>
      </footer>
    </div>
  );
}
