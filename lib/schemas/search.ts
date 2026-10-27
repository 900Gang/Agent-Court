import { fail, ok, type ServiceResult } from "@/lib/services/result";
import { cleanText } from "./text";

export const SEARCH = { maxQueryLength: 200, defaultLimit: 10, maxLimit: 20 } as const;

export type SearchQuery = { query: string; limit: number };

/**
 * Query parameters of GET /cases/search. `q` is required; control characters are removed and it is trimmed before
 * the length is checked. Unknown parameters are ignored. Messages name the field and the rule, never the input.
 */
export function parseSearchQuery(params: URLSearchParams): ServiceResult<SearchQuery, "invalid"> {
  const detail: Record<string, string> = {};

  let query = "";
  const rawQuery = params.get("q");
  if (rawQuery === null) {
    detail.q = "is required";
  } else {
    query = cleanText(rawQuery).trim();
    if (query === "") detail.q = "must not be empty";
    else if (query.length > SEARCH.maxQueryLength) detail.q = `at most ${SEARCH.maxQueryLength} characters`;
  }

  let limit: number = SEARCH.defaultLimit;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (/^[1-9][0-9]?$/.test(rawLimit) && Number(rawLimit) <= SEARCH.maxLimit) limit = Number(rawLimit);
    else detail.limit = `use a whole number from 1 to ${SEARCH.maxLimit}`;
  }

  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  return ok({ query, limit });
}
