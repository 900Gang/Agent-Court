const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A link into the operator's dashboard, built from the site's own origin and, at most, a checked UUID. Anything else in
 * the base address (a path, a query) is dropped. An id that is not a UUID gives the list instead of a case page, so a
 * hostile value can never end up in a link. A base address that is not http or https is a setting error.
 */
export function caseLink(baseUrl: string, page: "verdict" | "list", caseId: string | null): string {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError();
    origin = url.origin;
  } catch {
    throw new RangeError("not a valid base address");
  }
  const list = origin + "/dashboard/cases";
  return page === "verdict" && typeof caseId === "string" && UUID.test(caseId) ? list + "/" + caseId + "/verdict" : list;
}
