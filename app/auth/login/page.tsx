"use client";

import { authClient } from "@/lib/auth/authClient";

export default function LoginPage() {
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Sign in to Agent-Court</h1>
      <p>Operators sign in with GitHub. Your GitHub account must be at least 30 days old with a verified email.</p>
      <button
        type="button"
        onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/dashboard" })}
      >
        Continue with GitHub
      </button>
    </main>
  );
}
