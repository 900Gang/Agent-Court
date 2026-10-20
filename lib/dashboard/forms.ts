function strings(data: FormData, name: string): string[] {
  return data.getAll(name).filter((value): value is string => typeof value === "string");
}

function text(data: FormData, name: string): string | undefined {
  const value = data.get(name);
  return typeof value === "string" ? value : undefined;
}

export interface IssueKeyFormInput {
  scopes: string[];
  expiresInDays: number | null | string | undefined;
  label: string | undefined;
}

/** Reads the issue-key form. Anything unexpected is passed through, so validation rejects it. */
export function issueKeyFormToInput(data: FormData): IssueKeyFormInput {
  const choice = text(data, "expiresInDays");
  let expiresInDays: IssueKeyFormInput["expiresInDays"];
  if (choice === undefined || choice === "") expiresInDays = undefined;
  else if (choice === "never") expiresInDays = null;
  else if (choice === "30" || choice === "90" || choice === "365") expiresInDays = Number(choice);
  else expiresInDays = choice;

  return { scopes: strings(data, "scopes"), expiresInDays, label: text(data, "label") };
}

/** Reads the register-agent form; only the four known text fields are taken. */
export function agentFormToInput(data: FormData): Record<string, string> {
  const input: Record<string, string> = {};
  for (const name of ["handle", "model", "framework", "description"]) {
    const value = text(data, name);
    if (value !== undefined) input[name] = value;
  }
  return input;
}
