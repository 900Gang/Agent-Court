import { EscapedText } from "./EscapedText";

/** A label and a block of user text under it. Nothing at all when there is no text. */
export function Field({ label, text }: { label: string; text: string | null | undefined }) {
  if (text === null || text === undefined || text === "") return null;
  return (
    <div className="field">
      <p className="hint">{label}</p>
      <EscapedText text={text} as="pre" />
    </div>
  );
}
