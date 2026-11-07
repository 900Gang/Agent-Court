import path from "node:path";
import { parseGithubUrl, sameRepository } from "./sources";

/** Where the fetch tools keep the raw issue and fix text. Git-ignored: it holds third-party text and is never committed. */
export const WORK_DIR = ".import-work";

/**
 * Where the raw text of an issue and of its fix are cached, or null when the links are not a well-formed issue link and
 * pull request link of one repository. The names come from the strict link parser, so the path cannot leave the folder.
 */
export function rawTextPaths(workDir: string, issueUrl: string, fixUrl: string): { issue: string; fix: string } | null {
  const issue = parseGithubUrl(issueUrl);
  const fix = parseGithubUrl(fixUrl);
  if (!issue || !fix || issue.kind !== "issue" || fix.kind !== "pull" || !sameRepository(issueUrl, fixUrl)) return null;
  const folder = path.join(workDir, "raw", issue.owner, issue.repo);
  return { issue: path.join(folder, `issue-${issue.number}.txt`), fix: path.join(folder, `pull-${fix.number}.txt`) };
}