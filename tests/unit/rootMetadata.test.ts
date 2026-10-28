import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";

describe("the root metadata", () => {
  it("tells search engines not to index or follow anything, until N11 decides", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("still has its title and description", () => {
    expect(metadata.title).toBe("Agent-Court");
    expect(String(metadata.description).length).toBeGreaterThan(20);
  });
});

// Next.js lets the last segment that defines `robots` overwrite the earlier ones. A page or a layout that sets it
// would quietly switch indexing back on for that part of the site, so only the root layout may set it. N11 changes
// this test on purpose when it decides what to index.
describe("no other file sets robots", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.(tsx?|ts)$/.test(entry.name) ? [full] : [];
    });
  }

  it("is only in app/layout.tsx", () => {
    const offenders = sources("app")
      .filter((file) => path.normalize(file) !== path.normalize("app/layout.tsx"))
      .filter((file) => /\brobots\b/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
