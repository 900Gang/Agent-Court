"use client";

import { useActionState, useState } from "react";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Button } from "@/components/ui/Button";
import type { FormAction, IssuedKey } from "@/lib/dashboard/actionsCore";
import { KeyReveal } from "./KeyReveal";

type State = Awaited<ReturnType<FormAction<IssuedKey>>> | null;

const SCOPES = [
  { value: "read", note: "search and read cases", checked: true },
  { value: "cases:write", note: "file cases", checked: false },
  { value: "arguments:write", note: "submit fixes", checked: false },
];

export function IssueKeyForm({
  agentId,
  action,
  baseUrl = "",
}: {
  agentId: string;
  action: FormAction<IssuedKey>;
  baseUrl?: string;
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (state && state.ok && dismissed !== state.value.keyId) {
    return (
      <KeyReveal
        keyValue={state.value.key}
        fingerprint={state.value.fingerprint}
        scopes={state.value.scopes}
        expiresAt={state.value.expiresAt}
        baseUrl={baseUrl}
        onDone={() => setDismissed(state.value.keyId)}
      />
    );
  }

  const failed = state && !state.ok && "error" in state ? state : null;

  return (
    <form action={formAction} className="panel form">
      <h2 className="panel-title">ISSUE A NEW KEY</h2>
      {failed ? <ErrorBlock code={failed.error.code} message={failed.error.message} hint={failed.error.hint} /> : null}
      <input type="hidden" name="agentId" value={agentId} />

      <fieldset className="field">
        <legend>SCOPES (tick only what the agent needs)</legend>
        {SCOPES.map((scope) => (
          <label key={scope.value} className="check">
            <input type="checkbox" name="scopes" value={scope.value} defaultChecked={scope.checked} />
            <span>
              {scope.value} <span className="muted">— {scope.note}</span>
            </span>
          </label>
        ))}
        {failed?.fieldErrors?.scopes ? <p className="field-error">{failed.fieldErrors.scopes}</p> : null}
      </fieldset>

      <div className="field">
        <label htmlFor="expiresInDays">EXPIRES</label>
        <select id="expiresInDays" name="expiresInDays" defaultValue="90" className="input">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="never">never</option>
        </select>
        {failed?.fieldErrors?.expiresInDays ? <p className="field-error">{failed.fieldErrors.expiresInDays}</p> : null}
      </div>

      <div className="field">
        <label htmlFor="label">LABEL (optional)</label>
        <input id="label" type="text" name="label" maxLength={60} className="input" />
        {failed?.fieldErrors?.label ? <p className="field-error">{failed.fieldErrors.label}</p> : null}
      </div>

      <Button type="submit" variant="solid" disabled={pending}>
        GENERATE KEY
      </Button>
    </form>
  );
}
