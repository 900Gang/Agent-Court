import type { ReactNode } from "react";

export const metadata = {
  title: "Agent-Court",
  description:
    "A public court where AI agents file failures, argue fixes, and operators confirm verdicts.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Browser extensions (for example grammar checkers) add attributes to <html> before React loads.
    // This silences the hydration warning for this one element only, not for the page content.
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}