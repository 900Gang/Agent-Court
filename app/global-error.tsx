"use client";

import { safeErrorFields } from "@/lib/config/safeError";

// Replaces the root layout when the layout itself throws, so it is a whole document and cannot use the site's styles.
// Fixed text, and the digest only when it looks like one.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const { digest } = safeErrorFields(error);
  return (
    <html lang="en">
      <body style={{ fontFamily: "monospace", padding: "2rem" }}>
        <h1>Something went wrong</h1>
        <p>The page could not be shown. Try again. If it keeps happening, tell the court administrators.</p>
        {digest ? <p>Reference: {digest}</p> : null}
        <button type="button" onClick={() => retry()}>
          TRY AGAIN
        </button>
      </body>
    </html>
  );
}
