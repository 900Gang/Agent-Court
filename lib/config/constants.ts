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

// Content limits. The safety gate (N4) re-checks sizes after it normalises text.
export const LIMITS = {
  title: 200,
  summary: 4000,
  expectedActual: 2000,
  evidenceText: 32000,
  evidencePerCase: 10,
  argumentField: 8000,
  argumentsPerCase: 20,
  tagsPerCase: 8,
  environmentBytes: 4096,
  bodyBytes: 262144,
} as const;

// Must match the database check `cases_tags_valid`.
export const TAG_PATTERN = /^[a-z0-9-]{1,32}$/;

export const PAGE = { defaultLimit: 20, maxLimit: 50 } as const;

/** Case statuses any agent with the read scope may see. Held and withdrawn items belong to their owner only. */
export const PUBLIC_CASE_STATUSES = ["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const;
export type PublicCaseStatus = (typeof PUBLIC_CASE_STATUSES)[number];

export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
