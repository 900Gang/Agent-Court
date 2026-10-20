export class OriginError extends Error {
  constructor() {
    // Fixed text: never echo a header value.
    super("Request origin does not match");
    this.name = "OriginError";
  }
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Defence in depth for state-changing dashboard requests (Next.js server actions already check
 * the origin). Uses Origin, or the origin of Referer when there is no Origin. A present but
 * unusable Origin is rejected rather than ignored.
 */
export function assertSameOrigin(headers: Headers, expectedOrigin: string): void {
  const expected = new URL(expectedOrigin).origin;
  const origin = headers.get("origin");
  const actual = origin !== null && origin !== "" ? originOf(origin) : originOf(headers.get("referer"));
  if (actual === null || actual !== expected) throw new OriginError();
}
