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
  /** Upstash Redis REST endpoint. Null in development and test when not configured (in-memory limiter is used). */
  upstashUrl: string | null;
  upstashToken: string | null;
  /** When true, agent API traffic (/api/v1 and /mcp) is refused. */
  killSwitch: boolean;
  /** When true, agent write routes accept requests. Off by default; refused in production and staging until the safety gate ships. */
  apiWritesEnabled: boolean;
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
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KILL_SWITCH",
  "API_WRITES_ENABLED",
] as const;

const FLAG_ON = ["on", "true", "1"];
const FLAG_OFF = ["", "off", "false", "0"];

const schema = z
  .object({
    DATABASE_URL: z.url(),
    DATABASE_URL_DIRECT: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    APP_ENV: z.enum(APP_ENVS).default("development"),
    UPSTASH_REDIS_REST_URL: z.url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
    KILL_SWITCH: z.string().optional(),
    API_WRITES_ENABLED: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production" && !env.BETTER_AUTH_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must use https in production",
      });
    }

    // Upstash: both or neither, and required wherever the app is deployed.
    const deployed = env.APP_ENV === "production" || env.APP_ENV === "staging";
    const hasUrl = env.UPSTASH_REDIS_REST_URL !== undefined;
    const hasToken = env.UPSTASH_REDIS_REST_TOKEN !== undefined;
    const needed = deployed || hasUrl || hasToken;
    for (const [present, name] of [
      [hasUrl, "UPSTASH_REDIS_REST_URL"],
      [hasToken, "UPSTASH_REDIS_REST_TOKEN"],
    ] as const) {
      if (needed && !present) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "required together, and in production and staging",
        });
      }
    }

    // A kill switch that silently ignores a typo is worse than none: fail fast.
    const killSwitch = (env.KILL_SWITCH ?? "").toLowerCase();
    if (![...FLAG_ON, ...FLAG_OFF].includes(killSwitch)) {
      ctx.addIssue({ code: "custom", path: ["KILL_SWITCH"], message: "must be on or off" });
    }

    // Same rule for the write flag. The N3 gate stub does not redact, so writes stay off where real data lives.
    const writes = (env.API_WRITES_ENABLED ?? "").toLowerCase();
    if (![...FLAG_ON, ...FLAG_OFF].includes(writes)) {
      ctx.addIssue({ code: "custom", path: ["API_WRITES_ENABLED"], message: "must be on or off" });
    } else if (FLAG_ON.includes(writes) && deployed) {
      ctx.addIssue({
        code: "custom",
        path: ["API_WRITES_ENABLED"],
        message: "not allowed in production or staging until the safety gate ships",
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

  const secrets = new Set<string>([
    env.DATABASE_URL,
    env.DATABASE_URL_DIRECT,
    env.BETTER_AUTH_SECRET,
    env.GITHUB_CLIENT_SECRET,
  ]);
  if (env.UPSTASH_REDIS_REST_TOKEN) secrets.add(env.UPSTASH_REDIS_REST_TOKEN);
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
    upstashUrl: env.UPSTASH_REDIS_REST_URL ?? null,
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN ?? null,
    killSwitch: FLAG_ON.includes((env.KILL_SWITCH ?? "").toLowerCase()),
    apiWritesEnabled: FLAG_ON.includes((env.API_WRITES_ENABLED ?? "").toLowerCase()),
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
