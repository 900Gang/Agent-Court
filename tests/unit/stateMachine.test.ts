import { describe, expect, it } from "vitest";
import { caseStatus } from "@/db/schema";
import {
  CASE_EVENTS,
  MACHINE_STATES,
  TRANSITIONS,
  nextState,
  type CaseEvent,
  type MachineState,
} from "@/lib/services/stateMachine";

// Plan section 2.1, written out row by row. The test compares every state and event pair against it,
// so a missing transition and an extra one both fail.
const expected: Array<[MachineState, CaseEvent, MachineState]> = [
  ["new", "submit", "screening"],
  ["screening", "gate_pass", "open"],
  ["screening", "gate_flag", "held"],
  ["screening", "gate_block", "rejected"],
  ["held", "admin_approve", "open"],
  ["held", "admin_reject", "rejected"],
  ["open", "argument_published", "argued"],
  ["argued", "all_arguments_withdrawn", "open"],
  ["open", "verdict_issued", "resolved"],
  ["argued", "verdict_issued", "resolved"],
  ["open", "timeout", "closed_unresolved"],
  ["argued", "timeout", "closed_unresolved"],
  ["open", "case_withdrawn", "withdrawn"],
  ["argued", "case_withdrawn", "withdrawn"],
  ["resolved", "appeal", "under_appeal"],
  ["resolved", "review_opened", "under_appeal"],
  ["under_appeal", "upheld", "resolved"],
  ["under_appeal", "overturned", "argued"],
];

const expectedMap = new Map(expected.map(([from, event, to]) => [`${from}/${event}`, to]));

describe("state machine definitions", () => {
  it("knows the pseudo states and every stored case status", () => {
    expect(MACHINE_STATES).toContain("new");
    expect(MACHINE_STATES).toContain("screening");
    const stored = MACHINE_STATES.filter((state) => state !== "new" && state !== "screening");
    expect([...stored].sort()).toEqual([...caseStatus.enumValues].sort());
  });

  it("defines the fifteen events", () => {
    expect([...CASE_EVENTS].sort()).toEqual(
      [
        "submit",
        "gate_pass",
        "gate_flag",
        "gate_block",
        "admin_approve",
        "admin_reject",
        "argument_published",
        "all_arguments_withdrawn",
        "verdict_issued",
        "timeout",
        "case_withdrawn",
        "appeal",
        "review_opened",
        "upheld",
        "overturned",
      ].sort(),
    );
  });

  it("holds eighteen transitions with no duplicate (from, event) pair", () => {
    expect(TRANSITIONS).toHaveLength(18);
    const keys = TRANSITIONS.map((row) => `${row.from}/${row.event}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the plan table row by row", () => {
    const actual = TRANSITIONS.map((row) => [row.from, row.event, row.to]);
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length);
  });
});

describe("nextState", () => {
  for (const state of MACHINE_STATES) {
    for (const event of CASE_EVENTS) {
      const to = expectedMap.get(`${state}/${event}`) ?? null;
      it(`${state} + ${event} gives ${to ?? "illegal"}`, () => {
        expect(nextState(state, event)).toBe(to);
      });
    }
  }

  it.each(["closed_unresolved", "withdrawn", "rejected"] as const)(
    "treats %s as terminal for every event",
    (state) => {
      for (const event of CASE_EVENTS) {
        expect(nextState(state, event)).toBeNull();
      }
    },
  );

  it("does not publish an argument on a held case", () => {
    expect(nextState("held", "argument_published")).toBeNull();
    expect(nextState("open", "argument_published")).toBe("argued");
  });

  it("returns null, not a throw, for values outside the machine", () => {
    expect(nextState("bogus" as MachineState, "submit")).toBeNull();
    expect(nextState("open", "bogus" as CaseEvent)).toBeNull();
  });
});
