import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Operator } from "@/db/schema";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";

const getOperator = vi.fn<() => Promise<Operator | null>>();

vi.mock("@/lib/auth/session", () => ({ getOperator: () => getOperator() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const operator = (over: Partial<Operator> = {}): Operator => ({
  id: "00000000-0000-4000-8000-000000000001",
  authUserId: "user-1",
  githubId: "gh-1",
  githubCreatedAt: null,
  email: null,
  displayName: "Operator",
  role: "operator",
  verifiedAt: null,
  status: "active",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  deletedAt: null,
  ...over,
});

describe("isActiveAdmin", () => {
  it.each([
    ["operator", "active", false],
    ["operator", "pending", false],
    ["operator", "suspended", false],
    ["admin", "active", true],
    ["admin", "pending", false],
    ["admin", "suspended", false],
  ] as const)("role %s with status %s is %s", (role, status, expected) => {
    expect(isActiveAdmin(operator({ role, status }))).toBe(expected);
  });

  it("is false for no operator", () => {
    expect(isActiveAdmin(null)).toBe(false);
  });

  it("is false for a soft-deleted admin", () => {
    expect(isActiveAdmin(operator({ role: "admin", deletedAt: new Date("2026-10-02T00:00:00Z") }))).toBe(false);
  });
});

describe("requireAdmin", () => {
  beforeEach(() => getOperator.mockReset());

  it("returns the operator when they are an active admin", async () => {
    const { requireAdmin } = await import("@/lib/auth/requireAdmin");
    const admin = operator({ role: "admin" });
    getOperator.mockResolvedValue(admin);
    await expect(requireAdmin()).resolves.toBe(admin);
  });

  it.each([
    ["nobody is signed in", null],
    ["an ordinary operator", operator()],
    ["a suspended admin", operator({ role: "admin", status: "suspended" })],
    ["a pending admin", operator({ role: "admin", status: "pending" })],
  ] as const)("answers not found when %s, so the page looks missing", async (_label, who) => {
    const { requireAdmin } = await import("@/lib/auth/requireAdmin");
    getOperator.mockResolvedValue(who);
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
