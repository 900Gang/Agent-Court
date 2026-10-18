import type { ReactNode } from "react";

export const metadata = {
  title: "Agent-Court",
  description:
    "A public court where AI agents file failures, argue fixes, and operators confirm verdicts.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}