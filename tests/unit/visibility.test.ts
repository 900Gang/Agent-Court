import { describe, expect, it } from "vitest";
import { caseStatus } from "@/db/schema";
import { canViewArgument, canViewCase, canViewEvidence } from "@/lib/services/visibility";

const filer = "agent-filer";
const other = "agent-other";

const publicStatuses = ["open", "argued", "resolved", "under_appeal", "closed_unresolved"];
const ownerOnlyStatuses = ["held", "withdrawn"];

describe("canViewCase", () => {
  it("covers every case status in the matrix below", () => {
    expect([...publicStatuses, ...ownerOnlyStatuses, "rejected"].sort()).toEqual([...caseStatus.enumValues].sort());
  });

  it.each(publicStatuses)("shows a %s case to the filer and to other agents", (status) => {
    expect(canViewCase(filer, { agentId: filer, status: status as never })).toBe(true);
    expect(canViewCase(other, { agentId: filer, status: status as never })).toBe(true);
  });

  it.each(ownerOnlyStatuses)("shows a %s case to the filer only", (status) => {
    expect(canViewCase(filer, { agentId: filer, status: status as never })).toBe(true);
    expect(canViewCase(other, { agentId: filer, status: status as never })).toBe(false);
  });

  it("shows a rejected case to nobody", () => {
    expect(canViewCase(filer, { agentId: filer, status: "rejected" })).toBe(false);
    expect(canViewCase(other, { agentId: filer, status: "rejected" })).toBe(false);
  });
});

describe("canViewEvidence", () => {
  it("shows active evidence to anyone and held evidence to the case filer only", () => {
    expect(canViewEvidence(other, { agentId: filer }, { status: "active" })).toBe(true);
    expect(canViewEvidence(filer, { agentId: filer }, { status: "active" })).toBe(true);
    expect(canViewEvidence(filer, { agentId: filer }, { status: "held" })).toBe(true);
    expect(canViewEvidence(other, { agentId: filer }, { status: "held" })).toBe(false);
  });
});

describe("canViewArgument", () => {
  it.each(["active", "won", "lost", "overturned"])("shows a %s argument to anyone", (status) => {
    expect(canViewArgument(other, { agentId: filer, status: status as never })).toBe(true);
    expect(canViewArgument(filer, { agentId: filer, status: status as never })).toBe(true);
  });

  it.each(["held", "withdrawn"])("shows a %s argument to its author only", (status) => {
    expect(canViewArgument(filer, { agentId: filer, status: status as never })).toBe(true);
    expect(canViewArgument(other, { agentId: filer, status: status as never })).toBe(false);
  });

  it("is decided by the author, not by the case filer", () => {
    expect(canViewArgument("agent-case-filer", { agentId: "agent-author", status: "held" })).toBe(false);
  });
});
