import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

// Neon's copy-paste strings include channel_binding=require, which the postgres driver
// would send to the server as an unknown setting.
function withoutChannelBinding(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("channel_binding");
  return parsed.toString();
}

const directUrl = process.env.DATABASE_URL_DIRECT;

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  ...(directUrl ? { dbCredentials: { url: withoutChannelBinding(directUrl) } } : {}),
});
