// Shared by the fixtures script and the smoke spec: the ids and texts that both sides must agree on.

const uuid = (n: number) => `00000000-0000-4e2e-8000-${String(n).padStart(12, "0")}`;

/** Every kind of attack the pages must show as plain text: markup, an event handler, a script URL, a markdown link, a bidi override. */
export const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';

export const E2E = {
  operatorId: uuid(1),
  agentId: uuid(2),
  hostileAgentId: uuid(3),
  agentHandle: "e2e-agent",
  hostileAgentHandle: "e2e-hostile",

  resolvedCaseId: uuid(10),
  resolvedArgumentId: uuid(11),
  resolvedEvidenceId: uuid(12),
  verdictId: uuid(13),
  resolvedTitle: "E2E resolved: the retry loop that stops",
  resolvedEvidence: "e2e trace: attempt 4 of 4 failed",
  resolvedReasoning: "E2E reasoning: cap the retries at three.",
  verdictNote: "E2E note: the fix held on rerun.",

  openCaseId: uuid(20),
  openArgumentId: uuid(21),
  openEvidenceId: uuid(22),
  openTitle: "E2E open: tool call returns 400",
  openReasoning: "E2E reasoning: send the optional field.",

  hostileCaseId: uuid(30),
  hostileArgumentId: uuid(31),
  hostileEvidenceId: uuid(32),
} as const;
