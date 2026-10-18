import { describe, expect, it } from "vitest";
import { parseGithubProfile, stripProviderTokens } from "@/lib/auth/providerData";

describe("parseGithubProfile", () => {
  it("reads a numeric id, creation date and name", () => {
    expect(
      parseGithubProfile({ id: 12345, created_at: "2015-03-01T10:00:00Z", name: "Ada L", login: "ada" }),
    ).toEqual({
      githubId: "12345",
      githubCreatedAt: new Date("2015-03-01T10:00:00Z"),
      displayName: "Ada L",
    });
  });

  it("accepts a string id", () => {
    expect(parseGithubProfile({ id: "777", created_at: "2020-01-01T00:00:00Z" })?.githubId).toBe("777");
  });

  it.each([[{}], [{ id: null }], [{ id: "" }], [{ id: undefined, login: "ada" }]])(
    "returns null when the id is missing or empty: %j",
    (profile) => {
      expect(parseGithubProfile(profile)).toBeNull();
    },
  );

  it.each([[undefined], [null], ["not a date"], [""], [12]])(
    "gives a null creation date for %j",
    (createdAt) => {
      expect(parseGithubProfile({ id: 1, created_at: createdAt })?.githubCreatedAt).toBeNull();
    },
  );

  it("falls back from name to login to github:<id>", () => {
    expect(parseGithubProfile({ id: 1, name: "", login: "ada" })?.displayName).toBe("ada");
    expect(parseGithubProfile({ id: 12345 })?.displayName).toBe("github:12345");
  });
});

describe("stripProviderTokens", () => {
  it("nulls every token field and keeps the rest", () => {
    const stripped = stripProviderTokens({
      id: "acc-1",
      providerId: "github",
      accountId: "12345",
      accessToken: "gho_secret",
      refreshToken: "refresh_secret",
      idToken: "id_secret",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
    });
    expect(stripped).toEqual({
      id: "acc-1",
      providerId: "github",
      accountId: "12345",
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });

  it("does not modify its input", () => {
    const input = { accessToken: "gho_secret" };
    stripProviderTokens(input);
    expect(input.accessToken).toBe("gho_secret");
  });
});