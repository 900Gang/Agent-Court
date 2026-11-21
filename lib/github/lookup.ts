import { INVITES } from "@/lib/config/constants";

// Turns a GitHub login into the account's numeric id (N11, AC-1107). One unauthenticated GET to GitHub's public user
// endpoint, with a time limit. The login is checked against GitHub's own pattern before anything is sent, so the address
// cannot be steered. Only an answer that is a user with a positive whole id and the same login is accepted.

export type GithubLookupErrorCode = "invalid_login" | "not_found" | "unavailable";

export class GithubLookupError extends Error {
  readonly code: GithubLookupErrorCode;
  constructor(code: GithubLookupErrorCode) {
    super(code);
    this.name = "GithubLookupError";
    this.code = code;
  }
}

export type GithubAccount = { id: string; login: string };
export type GithubLookup = (login: string) => Promise<GithubAccount>;

export const isValidGithubLogin = (value: unknown): value is string => typeof value === "string" && INVITES.loginPattern.test(value);

const ENDPOINT = "https://api.github.com/users/";

export function createGithubLookup(fetchImpl: typeof fetch = fetch, timeoutMs: number = INVITES.lookupTimeoutMs): GithubLookup {
  return async (login) => {
    if (!isValidGithubLogin(login)) throw new GithubLookupError("invalid_login");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(ENDPOINT + login, {
        headers: { accept: "application/vnd.github+json", "user-agent": "Agent-Court", "x-github-api-version": "2022-11-28" },
        signal: controller.signal,
      });
      if (response.status === 404) throw new GithubLookupError("not_found");
      if (!response.ok) throw new GithubLookupError("unavailable");
      const body: unknown = await response.json();
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const { id, type } = record;
      const returned = record.login;
      if (type !== "User" || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new GithubLookupError("not_found");
      if (!isValidGithubLogin(returned) || returned.toLowerCase() !== login.toLowerCase()) throw new GithubLookupError("not_found");
      return { id: String(id), login: returned };
    } catch (error) {
      if (error instanceof GithubLookupError) throw error;
      // A network error, a timeout or an answer that is not JSON. Nothing from it is kept.
      throw new GithubLookupError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}
