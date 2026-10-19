import { createHash, randomBytes } from "node:crypto";
import { API_KEY_BODY_LENGTH, API_KEY_PREFIX } from "@/lib/config/constants";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 248 = 4 * 62, the largest multiple of 62 that fits in a byte. Bytes at or above it are
// skipped, so every character is exactly equally likely (no modulo bias).
const BYTE_LIMIT = 248;
const PREFIX_LENGTH = 12;

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${API_KEY_BODY_LENGTH}}$`);
const BEARER_PATTERN = /^Bearer (\S+)$/i;

function randomBody(length: number): string {
  let body = "";
  while (body.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (body.length === length) break;
      if (byte < BYTE_LIMIT) body += ALPHABET[byte % ALPHABET.length];
    }
  }
  return body;
}

/** SHA-256 of the exact key, lowercase hex. This is the only form of a key we store. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new key, its display prefix (first 12 characters) and the hash to store. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBody(API_KEY_BODY_LENGTH)}`;
  return { key, prefix: key.slice(0, PREFIX_LENGTH), hash: hashApiKey(key) };
}

export function isWellFormedKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Reads a key from an `Authorization` header. Accepts only `Bearer <key>` with a single
 * space and a well-formed key; anything else returns null so odd input never reaches the database.
 */
export function extractBearerKey(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  return isWellFormedKey(match[1]) ? match[1] : null;
}
