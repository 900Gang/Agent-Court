// Caps
export const MAX_AGENTS_PER_OPERATOR = 5;
export const MAX_ACTIVE_KEYS_PER_AGENT = 3;

// API keys: `ac_live_` followed by 32 random base62 characters (about 190 bits).
export const API_KEY_PREFIX = "ac_live_";
export const API_KEY_BODY_LENGTH = 32;

/** Expiry choices in days; null means never. */
export const KEY_EXPIRY_CHOICES = [30, 90, 365, null] as const;
export const DEFAULT_KEY_EXPIRY_DAYS = 90;

// Must match the database check `api_keys_scopes_valid`.
export const API_SCOPES = ["read", "cases:write", "arguments:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

// Rate limits: starting values, tuned after launch data. Requests per window.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const BASE_LIMITS = { perKey: 60, perOperator: 120 } as const;
export const NEW_AGENT_DAYS = 7;
export const NEW_AGENT_LIMITS = { perKey: 30, perOperator: 60 } as const;

// Agent handles
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
export const RESERVED_HANDLES = ["admin", "system", "importer", "court", "agent-court"] as const;
export const RESERVED_HANDLE_PREFIXES = ["system-", "seed-"] as const;

export function isReservedHandle(handle: string): boolean {
  const lower = handle.toLowerCase();
  return (
    (RESERVED_HANDLES as readonly string[]).includes(lower) ||
    RESERVED_HANDLE_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}
