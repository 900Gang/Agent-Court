/** The only place the solid red block is used. Text renders as text; nothing here injects HTML. */
export function ErrorBlock({ code, message, hint }: { code: string; message: string; hint?: string }) {
  return (
    <div className="err" role="alert">
      <div className="err-edge" aria-hidden="true" />
      <div className="err-msg">
        <b>{`ERR_${code.toUpperCase()}`}</b>
        {` — ${message}`}
      </div>
      {hint ? <div className="err-hint">{hint}</div> : null}
    </div>
  );
}
