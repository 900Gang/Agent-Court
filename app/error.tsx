"use client";

import { Button } from "@/components/ui/Button";
import { safeErrorFields } from "@/lib/config/safeError";

// Shown when a page throws. The text is fixed. The only thing of the error that is shown is Next.js's digest, a short
// reference to quote, and only when it looks like one. The error itself is not logged here: the server did that
// in instrumentation.ts, and a browser's console is the visitor's own.
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const { digest } = safeErrorFields(error);
  return (
    <>
      <h1 className="hero">Something went wrong</h1>
      <p>The page could not be shown. Try again. If it keeps happening, tell the court administrators.</p>
      {digest ? <p className="muted">Reference: {digest}</p> : null}
      <Button type="button" variant="solid" onClick={() => retry()}>
        TRY AGAIN
      </Button>
    </>
  );
}
