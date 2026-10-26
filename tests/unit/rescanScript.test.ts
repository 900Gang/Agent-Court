import { describe, expect, it } from "vitest";
import { formatSummary, parseRescanArgs } from "@/scripts/rescan-held";

describe("formatSummary", () => {
  it("is one line of counts and nothing else", () => {
    const line = formatSummary({ examined: 3, redacted: 2, rejected: 1, unchanged: 0, failed: 0, publishedStale: 4 });
    expect(line).toBe("examined=3 redacted=2 rejected=1 unchanged=0 failed=0 published_stale=4");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/^(?:[a-z_]+=\d+ ?)+$/);
  });
});

describe("parseRescanArgs", () => {
  it("is a dry run by default", () => {
    expect(parseRescanArgs([])).toEqual({ apply: false });
  });

  it("writes only with --apply", () => {
    expect(parseRescanArgs(["--apply"])).toEqual({ apply: true });
  });

  it.each([["--appply"], ["apply"], ["--apply", "--force"], ["--dry-run"], ["-a"]])("refuses %j rather than guess", (...args) => {
    expect(() => parseRescanArgs(args.flat())).toThrow(/usage/i);
  });
});
