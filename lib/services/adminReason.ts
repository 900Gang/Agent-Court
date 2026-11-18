import { OPS } from "@/lib/config/constants";

/**
 * The reason an administrator gives for flipping the kill switch or suspending an agent: a string of 10 to 200
 * characters after trimming, or null. It goes to the audit row (which scrubs token-shaped strings) and nowhere else. It
 * is admin-written and never shown to an agent or a visitor, so it does not pass the safety gate.
 */
export function parseAdminReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= OPS.reasonMin && reason.length <= OPS.reasonMax ? reason : null;
}
