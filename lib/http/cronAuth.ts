import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * True only when a secret is configured and the Authorization header is exactly `Bearer <secret>`. Both sides are
 * hashed first, so the comparison always sees two values of the same length and takes the same time whether the
 * header is short, long or almost right. Never throws, whatever the header holds.
 */
export function verifyCronRequest(request: Request, secret: string | null): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
