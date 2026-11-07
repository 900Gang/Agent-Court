import { execFile } from "node:child_process";

/** Runs `gh` with these arguments and answers its output. Injected, so tests use a fake. */
export type GhRunner = (args: string[]) => Promise<string>;

/** A failed gh call. The message is fixed: what gh printed can quote third-party text and is never kept. */
export class GhError extends Error {
  readonly notFound: boolean;
  constructor(message: string, notFound: boolean) {
    super(message);
    this.name = "GhError";
    this.notFound = notFound;
  }
}

/** The one shape of call these tools make: a read-only GET of one API path. */
export function ghArgs(endpoint: string): string[] {
  return ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", endpoint];
}

/** The real runner: gh is started directly with an argument list. No shell is involved, so no argument is ever parsed. */
export const realGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new GhError("gh failed", /\b404\b|Not Found/i.test(String(stderr))));
        return;
      }
      resolve(stdout);
    });
  });

/** One GET answered as parsed JSON. A missing item is a GhError with notFound; every other failure has a fixed message. */
export async function ghJson(gh: GhRunner, endpoint: string): Promise<unknown> {
  let text: string;
  try {
    text = await gh(ghArgs(endpoint));
  } catch (error) {
    if (error instanceof GhError && error.notFound) throw new GhError("not found", true);
    throw new Error("GitHub request failed");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub request failed");
  }
}