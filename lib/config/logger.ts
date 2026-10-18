const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

const SENSITIVE_EXACT = new Set(["key", "body", "cookie", "setcookie", "authorization"]);
const SENSITIVE_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_EXACT.has(normalized) || SENSITIVE_PARTS.some((part) => normalized.includes(part));
}

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bac_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
];

function scrubString(value: string): string {
  let output = value;
  for (const [pattern, replacement] of STRING_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return scrubString(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
    case "symbol":
      return String(value);
    case "function":
      return "[Function]";
  }

  const object = value as object;
  if (seen.has(object)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  seen.add(object);

  if (object instanceof Error) {
    return { name: object.name, message: scrubString(object.message) };
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "[Invalid Date]" : object.toISOString();
  }
  if (Array.isArray(object)) {
    return object.map((item) => scrubValue(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(object)) {
    if (isSensitiveKey(key) && inner !== null && typeof inner !== "number" && typeof inner !== "boolean") {
      output[key] = REDACTED;
    } else {
      output[key] = scrubValue(inner, depth + 1, seen);
    }
  }
  return output;
}

/** Returns a copy of value that is safe to log: sensitive keys, tokens, JWTs, our API keys and URL passwords removed. */
export function scrub(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const time = new Date().toISOString();
  let line: string;
  try {
    line = JSON.stringify({
      level,
      message: scrubString(message),
      meta: meta === undefined ? undefined : scrub(meta),
      time,
    });
  } catch {
    line = JSON.stringify({ level, message: "[unserializable log entry]", time });
  }
  console[level](line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};