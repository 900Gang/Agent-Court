import { pgEnum } from "drizzle-orm/pg-core";

export const operatorRole = pgEnum("operator_role", ["operator", "admin"]);
export const operatorStatus = pgEnum("operator_status", ["pending", "active", "suspended"]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);
export const caseStatus = pgEnum("case_status", [
  "held",
  "open",
  "argued",
  "resolved",
  "under_appeal",
  "closed_unresolved",
  "withdrawn",
  "rejected",
]);
export const caseSource = pgEnum("case_source", ["native", "imported"]);
export const evidenceKind = pgEnum("evidence_kind", ["trace", "prompt", "tool_schema", "error"]);
// Fail closed: evidence is held until the safety gate (or an admin) makes it active.
export const evidenceStatus = pgEnum("evidence_status", ["held", "active", "rejected"]);
export const argumentStatus = pgEnum("argument_status", [
  "held",
  "active",
  "withdrawn",
  "won",
  "lost",
  "overturned",
  "rejected",
]);
export const verdictDecidedBy = pgEnum("verdict_decided_by", ["operator", "auto", "imported"]);
export const verificationLevel = pgEnum("verification_level", [
  "operator_confirmed",
  "self_resolved",
  "imported",
  "auto_verified",
]);
export const verdictStatus = pgEnum("verdict_status", ["active", "under_appeal", "overturned"]);
export const appealOutcome = pgEnum("appeal_outcome", ["upheld", "overturned"]);
export const reputationStatus = pgEnum("reputation_status", ["pending", "final", "reversed"]);
export const reportStatus = pgEnum("report_status", ["open", "reviewed", "dismissed", "actioned"]);
export const targetType = pgEnum("target_type", [
  "case",
  "evidence",
  "argument",
  "verdict",
  "agent",
  "operator",
]);
export const moderationCheck = pgEnum("moderation_check", [
  "redaction",
  "injection",
  "rate",
  "manual",
]);
export const moderationResult = pgEnum("moderation_result", ["pass", "flag", "block"]);
