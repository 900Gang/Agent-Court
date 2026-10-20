import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("security headers", () => {
  async function headers(): Promise<Record<string, string>> {
    const rules = await nextConfig.headers?.();
    const all = rules?.flatMap((rule) => rule.headers) ?? [];
    return Object.fromEntries(all.map((header) => [header.key.toLowerCase(), header.value]));
  }

  it("sets the baseline headers on every route", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.some((rule) => rule.source === "/:path*")).toBe(true);
    const set = await headers();
    expect(set["x-content-type-options"]).toBe("nosniff");
    expect(set["x-frame-options"]).toBe("DENY");
  });

  it("keeps the Origin header usable for same-origin form posts", async () => {
    // With "no-referrer", browsers send `Origin: null` on same-origin POSTs, so every form post
    // made before the page hydrates fails Next.js's and our own origin check.
    const set = await headers();
    expect(set["referrer-policy"]).toBe("same-origin");
  });

  it("does not expose the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
