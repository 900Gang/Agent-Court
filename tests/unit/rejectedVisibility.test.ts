import { describe, expect, it } from "vitest";
import { argumentStatus, evidenceStatus } from "@/db/schema";
import { canViewArgument, canViewEvidence } from "@/lib/services/visibility";

const author = "agent-author";
const other = "agent-other";
const filer = "agent-filer";

// Every status is listed in exactly one of the two groups, so a new status cannot be added without a decision.
const ARGUMENTS_PUBLIC = ["active", "won", "lost", "overturned"];
const ARGUMENTS_OWNER_ONLY = ["held", "withdrawn", "rejected"];
const EVIDENCE_PUBLIC = ["active"];
const EVIDENCE_OWNER_ONLY = ["held", "rejected"];

describe("argument visibility covers every status", () => {
  it("lists each argument status once", () => {
    expect([...ARGUMENTS_PUBLIC, ...ARGUMENTS_OWNER_ONLY].sort()).toEqual([...argumentStatus.enumValues].sort());
  });

  it.each(ARGUMENTS_PUBLIC)("shows a %s argument to anyone", (status) => {
    expect(canViewArgument(other, { agentId: author, status: status as never })).toBe(true);
    expect(canViewArgument(author, { agentId: author, status: status as never })).toBe(true);
  });

  it.each(ARGUMENTS_OWNER_ONLY)("shows a %s argument to its author only", (status) => {
    expect(canViewArgument(author, { agentId: author, status: status as never })).toBe(true);
    expect(canViewArgument(other, { agentId: author, status: status as never })).toBe(false);
    expect(canViewArgument(filer, { agentId: author, status: status as never })).toBe(false);
  });
});

describe("evidence visibility covers every status", () => {
  it("lists each evidence status once", () => {
    expect([...EVIDENCE_PUBLIC, ...EVIDENCE_OWNER_ONLY].sort()).toEqual([...evidenceStatus.enumValues].sort());
  });

  it.each(EVIDENCE_PUBLIC)("shows %s evidence to anyone", (status) => {
    expect(canViewEvidence(other, { agentId: filer }, { status: status as never })).toBe(true);
  });

  it.each(EVIDENCE_OWNER_ONLY)("shows %s evidence to the case filer only", (status) => {
    expect(canViewEvidence(filer, { agentId: filer }, { status: status as never })).toBe(true);
    expect(canViewEvidence(other, { agentId: filer }, { status: status as never })).toBe(false);
  });
});
