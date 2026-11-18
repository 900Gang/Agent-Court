// What may be said about an error in a log or on an error page (N10, AC-1003, AC-1004). The message of an exception can
// quote data, a stack can name values, a request's path carries its query and its headers carry keys and cookies, so none
// of those is ever used. What is left is a class name, Next.js's digest, and the route pattern: all fixed by our own code.
//
// Pure and free of server imports, so an error page (a client component) can use it too.

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DIGEST = /^[A-Za-z0-9_-]{1,64}$/;
const ROUTE_PATTERN = /^[A-Za-z0-9/_\-[\]().@%]{1,200}$/;
const METHOD = /^[A-Z]{3,10}$/;
const ROUTE_TYPES = ["render", "route", "action", "proxy"] as const;
const RENDER_SOURCES = ["react-server-components", "react-server-components-payload", "server-rendering"] as const;

export type SafeErrorFields = { errorClass: string; digest?: string };

function nameOf(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  const name = (error.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && IDENTIFIER.test(name) ? name : "Error";
}

function digestOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && DIGEST.test(digest) ? digest : undefined;
}

/** The class name and, when it looks like one, the digest. Never the message, the stack or the cause. Never throws. */
export function safeErrorFields(error: unknown): SafeErrorFields {
  try {
    const digest = digestOf(error);
    return digest === undefined ? { errorClass: nameOf(error) } : { errorClass: nameOf(error), digest };
  } catch {
    return { errorClass: "NonError" };
  }
}

const pick = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/**
 * The fields of the log line for a request error. The request is read for its method only: its path (with the query), its
 * headers and its body are not used. The route is the route file's pattern from the context, kept only if it is made of
 * plain path characters. Anything that does not fit becomes a fixed word or is left out. Never throws.
 */
export function describeRequestError(error: unknown, request: unknown, context: unknown): Record<string, string> {
  const fields: Record<string, string> = { ...safeErrorFields(error) };
  try {
    const method = (request as { method?: unknown } | null | undefined)?.method;
    fields.method = typeof method === "string" && METHOD.test(method) ? method : "OTHER";

    const ctx = (context ?? {}) as { routePath?: unknown; routeType?: unknown; renderSource?: unknown };
    fields.route = typeof ctx.routePath === "string" && ROUTE_PATTERN.test(ctx.routePath) ? ctx.routePath : "[unknown]";
    const routeType = pick(ROUTE_TYPES, ctx.routeType);
    if (routeType) fields.routeType = routeType;
    const renderSource = pick(RENDER_SOURCES, ctx.renderSource);
    if (renderSource) fields.renderSource = renderSource;
  } catch {
    fields.method ??= "OTHER";
    fields.route ??= "[unknown]";
  }
  return fields;
}
