import { caseStatus } from "@/db/schema";

export const CASE_EVENTS = [
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
] as const;

export type CaseEvent = (typeof CASE_EVENTS)[number];

/** `new` and `screening` exist only inside a request: the gate runs synchronously, so they are never stored. */
export const MACHINE_STATES = ["new", "screening", ...caseStatus.enumValues] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

type Transition = { from: MachineState; event: CaseEvent; to: MachineState };

/** Plan section 2.1 as data. `closed_unresolved`, `withdrawn` and `rejected` are terminal: they have no rows. */
export const TRANSITIONS: readonly Transition[] = [
  { from: "new", event: "submit", to: "screening" },
  { from: "screening", event: "gate_pass", to: "open" },
  { from: "screening", event: "gate_flag", to: "held" },
  { from: "screening", event: "gate_block", to: "rejected" },
  { from: "held", event: "admin_approve", to: "open" },
  { from: "held", event: "admin_reject", to: "rejected" },
  { from: "open", event: "argument_published", to: "argued" },
  { from: "argued", event: "all_arguments_withdrawn", to: "open" },
  { from: "open", event: "verdict_issued", to: "resolved" },
  { from: "argued", event: "verdict_issued", to: "resolved" },
  { from: "open", event: "timeout", to: "closed_unresolved" },
  { from: "argued", event: "timeout", to: "closed_unresolved" },
  { from: "open", event: "case_withdrawn", to: "withdrawn" },
  { from: "argued", event: "case_withdrawn", to: "withdrawn" },
  { from: "resolved", event: "appeal", to: "under_appeal" },
  { from: "resolved", event: "review_opened", to: "under_appeal" },
  { from: "under_appeal", event: "upheld", to: "resolved" },
  { from: "under_appeal", event: "overturned", to: "argued" },
];

const LOOKUP = new Map(TRANSITIONS.map((row) => [`${row.from}/${row.event}`, row.to]));

/** The state after `event`, or null when the event is not allowed from `from`. */
export function nextState(from: MachineState, event: CaseEvent): MachineState | null {
  return LOOKUP.get(`${from}/${event}`) ?? null;
}
