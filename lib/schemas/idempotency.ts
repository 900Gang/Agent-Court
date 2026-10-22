import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/config/constants";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

/** The Idempotency-Key header. A missing header is fine (no key); a malformed one is not. */
export function parseIdempotencyKey(header: string | null): ServiceResult<string | null, "invalid"> {
  if (header === null) return ok(null);
  return IDEMPOTENCY_KEY_PATTERN.test(header)
    ? ok(header)
    : fail("invalid", { "Idempotency-Key": "use 8 to 128 letters, digits or the characters _ . : -" });
}
