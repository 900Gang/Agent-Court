import { PAGE, PUBLIC_CASE_STATUSES, TAG_PATTERN, type PublicCaseStatus } from "@/lib/config/constants";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

export type Cursor = { createdAt: Date; id: string };

export type ListQuery = {
  limit: number;
  cursor: Cursor | null;
  status: PublicCaseStatus | null;
  tag: string | null;
  needsArguments: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 200;

/** An opaque keyset cursor: base64url of {"t": ISO timestamp, "i": id}. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id }), "utf8").toString("base64url");
}

/** Null for anything that is not exactly what encodeCursor produces. */
export function decodeCursor(value: string): Cursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== "string" || typeof i !== "string" || !UUID.test(i)) return null;
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== t) return null;
  return { createdAt, id: i };
}

/** Query parameters of GET /cases. Unknown parameters are ignored; known ones must be valid. */
export function parseListQuery(params: URLSearchParams): ServiceResult<ListQuery, "invalid"> {
  const detail: Record<string, string> = {};

  let limit: number = PAGE.defaultLimit;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (/^[1-9][0-9]{0,2}$/.test(rawLimit) && Number(rawLimit) <= PAGE.maxLimit) limit = Number(rawLimit);
    else detail.limit = `use a whole number from 1 to ${PAGE.maxLimit}`;
  }

  let cursor: Cursor | null = null;
  const rawCursor = params.get("cursor");
  if (rawCursor !== null) {
    cursor = decodeCursor(rawCursor);
    if (cursor === null) detail.cursor = "use the next_cursor value from a previous response";
  }

  let status: PublicCaseStatus | null = null;
  const rawStatus = params.get("status");
  if (rawStatus !== null) {
    const match = PUBLIC_CASE_STATUSES.find((candidate) => candidate === rawStatus);
    if (match) status = match;
    else detail.status = `use one of ${PUBLIC_CASE_STATUSES.join(", ")}`;
  }

  let tag: string | null = null;
  const rawTag = params.get("tag");
  if (rawTag !== null) {
    if (TAG_PATTERN.test(rawTag)) tag = rawTag;
    else detail.tag = "use lower-case letters, digits and hyphens, 1 to 32 characters";
  }

  let needsArguments = false;
  const rawNeeds = params.get("needs_arguments");
  if (rawNeeds !== null) {
    if (rawNeeds === "true") needsArguments = true;
    else if (rawNeeds !== "false") detail.needs_arguments = "use true or false";
  }

  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  return ok({ limit, cursor, status, tag, needsArguments });
}
