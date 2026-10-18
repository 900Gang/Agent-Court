import { z } from "zod";

export const APP_ENVS = ["development", "staging", "production", "test"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export interface ServerEnv {
  databaseUrl: string;
  databaseUrlDirect: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  appEnv: AppEnv;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

const KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "APP_ENV",
] as const;

const schema = z
  .object({
    DATABASE_URL: z.url(),
    DATABASE_URL_DIRECT: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    APP_ENV: z.enum(APP_ENVS).default("development"),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production" && !env.BETTER_AUTH_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must use https in production",
      });
    }
  });

/**
 * Validates environment variables. Error messages name variables and reasons only,
 * never values, so a failed boot cannot leak a secret into logs.
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const input: Record<string, string | undefined> = {};
  for (const name of KEYS) {
    const value = source[name];
    input[name] = value === undefined || value === "" ? undefined : value;
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = new Map<string, string>();
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? "environment");
      if (problems.has(name)) continue;
      let reason: string;
      if (input[name] === undefined) reason = "missing";
      else if (issue.code === "too_small") reason = "invalid: too short, minimum 32 characters";
      else if (issue.code === "custom") reason = `invalid: ${issue.message}`;
      else if (issue.code === "invalid_value") reason = `invalid: must be one of ${APP_ENVS.join(", ")}`;
      else reason = "invalid";
      problems.set(name, reason);
    }
    const list = [...problems].map(([name, reason]) => `${name} (${reason})`).join("; ");
    throw new EnvError(`Invalid environment variables: ${list}`);
  }

  const env = result.data;

  const secrets = new Set([
    env.DATABASE_URL,
    env.DATABASE_URL_DIRECT,
    env.BETTER_AUTH_SECRET,
    env.GITHUB_CLIENT_SECRET,
  ]);
  const leaked = Object.entries(source)
    .filter(([name, value]) => name.startsWith("NEXT_PUBLIC_") && value !== undefined && secrets.has(value))
    .map(([name]) => name);
  if (leaked.length > 0) {
    throw new EnvError(
      `Invalid environment variables: ${leaked.join(", ")} (public variable holds a server secret)`,
    );
  }

  return {
    databaseUrl: env.DATABASE_URL,
    databaseUrlDirect: env.DATABASE_URL_DIRECT,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    betterAuthUrl: env.BETTER_AUTH_URL,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    appEnv: env.APP_ENV,
  };
}

let cached: ServerEnv | undefined;

/** The only place the application reads process.env. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

export function resetServerEnvCache(): void {
  cached = undefined;
}