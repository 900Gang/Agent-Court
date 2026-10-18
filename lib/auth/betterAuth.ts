import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";
import { getServerEnv } from "@/lib/config/env";
import { logger } from "@/lib/config/logger";
import { linkOperatorToUser, recordGithubLogin } from "@/lib/services/operatorService";
import { parseGithubProfile, stripProviderTokens } from "./providerData";

function createAuth() {
  const env = getServerEnv();
  const db = getDb();

  return betterAuth({
    baseURL: env.betterAuthUrl,
    secret: env.betterAuthSecret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    socialProviders: {
      github: {
        clientId: env.githubClientId,
        clientSecret: env.githubClientSecret,
      },
    },
    user: {
      // Runs on every GitHub sign-in with the raw GitHub profile (it includes created_at).
      // It must never throw: a throw rejects the login with a 403.
      validateUserInfo: async ({ user: incoming, source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "github") return;
        try {
          const identity = parseGithubProfile(source.oauth.profile ?? {});
          if (identity === null) {
            logger.warn("github login without a usable profile id");
            return;
          }
          await recordGithubLogin(db, {
            ...identity,
            email: typeof incoming.email === "string" ? incoming.email : null,
            emailVerified: incoming.emailVerified === true,
          });
        } catch (error) {
          logger.error("recording github login failed", { error });
        }
      },
    },
    databaseHooks: {
      // Provider tokens are never stored: we only need the profile, which we already have.
      account: {
        create: { before: async (record) => ({ data: stripProviderTokens(record) }) },
        update: { before: async (record) => ({ data: stripProviderTokens(record) }) },
      },
      session: {
        create: {
          after: async (created) => {
            try {
              await linkOperatorToUser(db, created.userId);
            } catch (error) {
              logger.error("linking operator to user failed", { error });
            }
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  instance ??= createAuth();
  return instance;
}
