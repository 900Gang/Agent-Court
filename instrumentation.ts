import { logger } from "@/lib/config/logger";
import { describeRequestError } from "@/lib/config/safeError";

/**
 * Next.js calls this for every server error: a route handler, a page, a server action or the proxy. It writes one log line
 * with the class of the error, the method, the route pattern, the route type, the render source and Next.js's digest.
 * It never writes the error's message or stack, the request's path or query, or any header (N10, AC-1003, AC-1004).
 *
 * The parameters are typed loosely on purpose: what Next.js passes is read through `describeRequestError`, which keeps
 * only values that match a fixed shape.
 */
export async function onRequestError(error: unknown, request: unknown, context: unknown): Promise<void> {
  logger.error("request error", describeRequestError(error, request, context));
}
