import { describe, expect, it, vi } from "vitest";
import { createGithubLookup, GithubLookupError, isValidGithubLogin } from "@/lib/github/lookup";

// N11 Task 1 (AC-1107): turning a GitHub login into an account id. No real network: fetch is replaced.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lookupWith = (fetchImpl: typeof fetch, timeoutMs?: number) => createGithubLookup(fetchImpl, timeoutMs);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GithubLookupError) return error.code;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("isValidGithubLogin", () => {
  it.each(["octocat", "a", "A1", "my-login", "user-name-123", "a".repeat(39), "0", "X-y-Z"])("accepts %s", (login) => {
    expect(isValidGithubLogin(login)).toBe(true);
  });

  it.each([
    "",
    "-leading",
    "trailing-",
    "double--hyphen",
    "a".repeat(40),
    "has space",
    "under_score",
    "dot.name",
    "slash/name",
    "q?x=1",
    "../etc",
    "name\n",
    "ünï",
    "@octocat",
    "octocat#1",
  ])("refuses %j", (login) => {
    expect(isValidGithubLogin(login)).toBe(false);
  });

  it.each([null, undefined, 5, {}, [], true])("refuses a value that is not a string (%s)", (value) => {
    expect(isValidGithubLogin(value)).toBe(false);
  });
});

describe("createGithubLookup", () => {
  it("asks the public user endpoint once, with no credentials, and returns the id and login", async () => {
    const fetchImpl = vi.fn(async () => json({ id: 583231, login: "octocat", type: "User" }));
    const result = await lookupWith(fetchImpl as never)("octocat");
    expect(result).toEqual({ id: "583231", login: "octocat" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/users/octocat");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).join(",").toLowerCase()).not.toContain("authorization");
  });

  it("returns the login as GitHub spells it, when the case differs", async () => {
    const fetchImpl = vi.fn(async () => json({ id: 5, login: "OctoCat", type: "User" }));
    expect(await lookupWith(fetchImpl as never)("octocat")).toEqual({ id: "5", login: "OctoCat" });
  });

  it("refuses a login that does not match the pattern before it sends anything", async () => {
    const fetchImpl = vi.fn();
    for (const login of ["../x", "a b", "", "q?x=1", "-x"]) {
      expect(await codeOf(lookupWith(fetchImpl as never)(login))).toBe("invalid_login");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says not_found for a 404", async () => {
    expect(await codeOf(lookupWith((async () => json({ message: "Not Found" }, 404)) as never)("nobody-here"))).toBe("not_found");
  });

  it.each([
    ["an organisation", { id: 9, login: "octocat", type: "Organization" }],
    ["a bot", { id: 9, login: "octocat", type: "Bot" }],
    ["an id that is not a number", { id: "9", login: "octocat", type: "User" }],
    ["an id of zero", { id: 0, login: "octocat", type: "User" }],
    ["a negative id", { id: -3, login: "octocat", type: "User" }],
    ["a fractional id", { id: 1.5, login: "octocat", type: "User" }],
    ["an id that is too large to be exact", { id: 2 ** 60, login: "octocat", type: "User" }],
    ["no login in the answer", { id: 9, type: "User" }],
    ["a different login than the one asked about", { id: 9, login: "someone-else", type: "User" }],
    ["a login that is not a valid one", { id: 9, login: "bad login", type: "User" }],
    ["something that is not an object", "hello"],
    ["null", null],
  ])("says not_found for an answer with %s", async (_label, body) => {
    expect(await codeOf(lookupWith((async () => json(body)) as never)("octocat"))).toBe("not_found");
  });

  it.each([403, 429, 500, 502, 503])("says unavailable for a %s", async (status) => {
    expect(await codeOf(lookupWith((async () => json({}, status)) as never)("octocat"))).toBe("unavailable");
  });

  it("says unavailable when the network fails, and keeps nothing of the error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND secret-host-name");
    });
    const error = await lookupWith(fetchImpl as never)("octocat").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubLookupError);
    expect(String((error as Error).message)).not.toContain("secret-host-name");
    expect((error as GithubLookupError).code).toBe("unavailable");
  });

  it("says unavailable when the answer is not JSON", async () => {
    expect(await codeOf(lookupWith((async () => new Response("<html>oops</html>", { status: 200 })) as never)("octocat"))).toBe("unavailable");
  });

  it("gives up after the time limit", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await codeOf(lookupWith(hang as never, 20)("octocat"))).toBe("unavailable");
  });
});
