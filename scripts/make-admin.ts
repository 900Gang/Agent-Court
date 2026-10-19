import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage:
//   pnpm db:make-admin --list        show operators (GitHub id, name, status, role)
//   pnpm db:make-admin <github_id>   make that operator an admin (they must have signed in once)
async function main(): Promise<void> {
  const { getDb, closeDb } = await import("@/db/client");
  const { operators } = await import("@/db/schema");
  const { promoteToAdmin } = await import("@/lib/services/operatorService");
  const { sql } = await import("drizzle-orm");

  const db = getDb();
  try {
    const argument = process.argv[2];
    if (!argument || argument === "--list") {
      const rows = await db
        .select({
          githubId: operators.githubId,
          displayName: operators.displayName,
          status: operators.status,
          role: operators.role,
          linked: sql<boolean>`${operators.authUserId} is not null`,
        })
        .from(operators)
        .orderBy(operators.createdAt);
      for (const row of rows) {
        console.log(`${row.githubId}\t${row.displayName}\t${row.status}\t${row.role}\tlogin-linked=${row.linked}`);
      }
      if (rows.length === 0) console.log("no operators yet");
      return;
    }

    const promoted = await promoteToAdmin(db, argument);
    if (!promoted) {
      console.error("No operator with that GitHub id. They must sign in once first (use --list).");
      process.exitCode = 1;
      return;
    }
    console.log(`${promoted.displayName} is now an admin (status: ${promoted.status}).`);
    if (promoted.status !== "active") {
      console.log("Note: admin pages also require status active.");
    }
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "make-admin failed");
    process.exitCode = 1;
  });
}
