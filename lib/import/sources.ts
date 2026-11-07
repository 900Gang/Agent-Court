/**
 * The repositories the court imports from, and the licence each one states (N9). A repository is on this list only when
 * GitHub reports an open licence for it and the owner has agreed; three whose licence GitHub does not state
 * (modelcontextprotocol/typescript-sdk, vercel/ai, BerriAI/litellm) are left out until a licence file is read by hand.
 * The licence of an imported case is looked up here, never taken from the entry that names the repository.
 */
export const IMPORT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "langchain-ai/langchain": "MIT",
  "langchain-ai/langgraph": "MIT",
  "run-llama/llama_index": "MIT",
  "microsoft/autogen": "CC-BY-4.0",
  "crewAIInc/crewAI": "MIT",
  "openai/openai-agents-python": "MIT",
  "microsoft/semantic-kernel": "MIT",
  "deepset-ai/haystack": "Apache-2.0",
  "huggingface/smolagents": "Apache-2.0",
  "modelcontextprotocol/python-sdk": "MIT",
  "pydantic/pydantic-ai": "MIT",
});

/** The licence of a listed repository, or null for anything else. Exact: no trimming, no case folding. */
export function licenseOf(repository: unknown): string | null {
  if (typeof repository !== "string") return null;
  return Object.hasOwn(IMPORT_SOURCES, repository) ? IMPORT_SOURCES[repository] : null;
}

export type GithubRef = { owner: string; repo: string; kind: "issue" | "pull"; number: number };

// The whole string must match: https, github.com and nothing else in front, plain names, one number, nothing after.
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/([1-9][0-9]{0,8})$/;

/**
 * An issue or pull request link on github.com, or null. Strict on purpose: the result is used to build a link on a page,
 * so a look-alike host, credentials, a port, a query, a fragment, a trailing part, a dot-dot name or an odd number is
 * refused rather than cleaned up.
 */
export function parseGithubUrl(url: unknown): GithubRef | null {
  if (typeof url !== "string") return null;
  const match = GITHUB_URL.exec(url);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo, kind: kind === "issues" ? "issue" : "pull", number: Number(number) };
}

/** True when both are well-formed GitHub links into the same repository (the name is compared exactly). */
export function sameRepository(a: unknown, b: unknown): boolean {
  const first = parseGithubUrl(a);
  const second = parseGithubUrl(b);
  return first !== null && second !== null && first.owner === second.owner && first.repo === second.repo;
}
/** `owner/name` of a well-formed issue or pull request link, or null. */
export function repositoryOf(url: unknown): string | null {
  const ref = parseGithubUrl(url);
  return ref ? `${ref.owner}/${ref.repo}` : null;
}

/**
 * The link to the fix. The import writes it alone on the last line of the verdict note; anything else on that line, or a
 * link that is not a pull request link, gives null.
 */
export function fixUrlFromNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const lines = note.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines[lines.length - 1];
  const ref = last === undefined ? null : parseGithubUrl(last);
  return last !== undefined && ref !== null && ref.kind === "pull" ? last : null;
}