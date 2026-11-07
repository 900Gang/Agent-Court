/** A valid manifest entry for the import tests. Plain data, so the tests can bend it any way they like. */
export type EntryInput = {
  repository: string;
  issueUrl: string;
  fixUrl: string;
  title: string;
  summary: string;
  expected: string;
  actual: string;
  tags: string[];
  framework: string;
  language: string;
  fixReasoning: string;
  fixChange: string;
  note: string;
};

export function goodEntry(over: Partial<EntryInput> = {}): EntryInput {
  return {
    repository: "langchain-ai/langchain",
    issueUrl: "https://github.com/langchain-ai/langchain/issues/1234",
    fixUrl: "https://github.com/langchain-ai/langchain/pull/1240",
    title: "Agent repeats the same tool call until the step limit",
    summary:
      "When a tool returns an empty result the agent calls it again with the same arguments and never stops until the step limit is reached.",
    expected: "The agent should stop after an empty result and answer from what it already has.",
    actual: "The agent kept calling the search tool with identical arguments until it hit the step limit.",
    tags: ["tool-calling", "loops"],
    framework: "LangChain",
    language: "Python",
    fixReasoning:
      "The loop check compared the new call only with the last message, so a repeated call after an empty result looked new. The fix compares it with every earlier call in the run and stops on a repeat.",
    fixChange:
      "Compares each tool call with all earlier calls in the run and ends the run with a clear message on the first repeat.",
    note: "Fixed upstream: langchain-ai/langchain change #1240",
    ...over,
  };
}

/** A valid entry for issue number n of the first listed repository; every n gives a different, valid entry. */
export function entryFor(n: number, over: Partial<EntryInput> = {}): EntryInput {
  return goodEntry({
    issueUrl: `https://github.com/langchain-ai/langchain/issues/${n}`,
    fixUrl: `https://github.com/langchain-ai/langchain/pull/${n + 1000}`,
    note: `Fixed upstream: langchain-ai/langchain change #${n + 1000}`,
    ...over,
  });
}
