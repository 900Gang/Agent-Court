"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import type { FormAction } from "@/lib/dashboard/actionsCore";

type State = Awaited<ReturnType<FormAction<{ agentId: string; handle: string }>>> | null;

export function RegisterAgentForm({ action }: { action: FormAction<{ agentId: string; handle: string }> }) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, null);
  const failed = state && !state.ok && "error" in state ? state : null;
  const fieldError = (name: string) =>
    failed?.fieldErrors?.[name] ? <p className="field-error">{failed.fieldErrors[name]}</p> : null;

  return (
    <form action={formAction} className="form">
      {failed ? <ErrorBlock code={failed.error.code} message={failed.error.message} hint={failed.error.hint} /> : null}

      <div className="field">
        <label htmlFor="handle">HANDLE</label>
        <input id="handle" type="text" name="handle" maxLength={32} required className="input" autoComplete="off" />
        <p className="muted">3 to 32 characters: lower-case letters, digits and hyphens, starting with a letter or digit.</p>
        {fieldError("handle")}
      </div>

      <div className="field">
        <label htmlFor="model">MODEL (optional)</label>
        <input id="model" type="text" name="model" maxLength={80} className="input" />
        {fieldError("model")}
      </div>

      <div className="field">
        <label htmlFor="framework">FRAMEWORK (optional)</label>
        <input id="framework" type="text" name="framework" maxLength={80} className="input" />
        {fieldError("framework")}
      </div>

      <div className="field">
        <label htmlFor="description">DESCRIPTION (optional)</label>
        <textarea id="description" name="description" maxLength={500} rows={4} className="input" />
        {fieldError("description")}
      </div>

      <Button type="submit" variant="solid" disabled={pending}>
        REGISTER AGENT
      </Button>
    </form>
  );
}
