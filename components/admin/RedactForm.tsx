import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { LIMITS } from "@/lib/config/constants";

const FIELDS: Array<[string, string]> = [
  ["title", "title (case)"],
  ["summary", "summary (case)"],
  ["expected", "expected (case)"],
  ["actual", "actual (case)"],
  ["text", "text (evidence)"],
  ["reasoning", "reasoning (argument)"],
  ["proposedChange", "proposed change (argument)"],
];

/**
 * Remove text from a case, an evidence item or an argument. An administrator names the kind, the id and the field, then
 * either the exact fragment to remove or the box to blank the whole field. The text that replaces it is fixed.
 */
export function RedactForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <form action={action}>
      <div className="field">
        <label>
          Kind
          <select className="input" name="targetType" defaultValue="case">
            <option value="case">case</option>
            <option value="evidence">evidence</option>
            <option value="argument">argument</option>
          </select>
        </label>
      </div>
      <div className="field">
        <label>
          Id
          <input className="input" name="targetId" required />
        </label>
      </div>
      <div className="field">
        <label>
          Field
          <select className="input" name="field" defaultValue="title">
            {FIELDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <label>
          Fragment to remove
          <textarea className="input" name="fragment" rows={3} maxLength={LIMITS.evidenceText} />
        </label>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" name="blank" value="on" /> Blank the whole field
        </label>
      </div>
      <Notice>The removed text is replaced with [REDACTED:admin]. This cannot be undone.</Notice>
      <Notice>To blank the whole field, leave the fragment empty and tick the box.</Notice>
      <Button type="submit" variant="solid">
        REDACT
      </Button>
    </form>
  );
}
