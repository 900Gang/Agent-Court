export interface GithubIdentity {
  githubId: string;
  githubCreatedAt: Date | null;
  displayName: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Reads the facts we need from the raw GitHub profile that Better Auth passes to
 * `user.validateUserInfo`. Returns null when there is no usable GitHub id.
 */
export function parseGithubProfile(profile: Record<string, unknown>): GithubIdentity | null {
  const rawId = profile.id;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const githubId = String(rawId).trim();
  if (githubId === "") return null;

  const createdAtText = nonEmptyString(profile.created_at);
  const parsed = createdAtText === null ? null : new Date(createdAtText);
  const githubCreatedAt = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return {
    githubId,
    githubCreatedAt,
    displayName: nonEmptyString(profile.name) ?? nonEmptyString(profile.login) ?? `github:${githubId}`,
  };
}

const TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
] as const;

/** Returns a copy of an account record with every provider token set to null. We never store them. */
export function stripProviderTokens<T extends object>(account: T): T {
  const copy: Record<string, unknown> = { ...account };
  for (const field of TOKEN_FIELDS) copy[field] = null;
  return copy as T;
}
