import { Button } from "@/components/ui/Button";
import { OPS } from "@/lib/config/constants";

type Action = (formData: FormData) => void | Promise<void>;

/**
 * The global switch. It offers the opposite of what the state is now: when the switch is off the form turns it on, and the
 * other way round. The reason goes to the audit log and nowhere else.
 */
export function KillSwitchForm({ on, action }: { on: boolean; action: Action }) {
  return (
    <form action={action}>
      <input type="hidden" name="value" value={on ? "off" : "on"} />
      <div className="field">
        <label>
          Reason ({OPS.reasonMin} to {OPS.reasonMax} characters)
          <input className="input" name="reason" required minLength={OPS.reasonMin} maxLength={OPS.reasonMax} />
        </label>
      </div>
      <Button type="submit" variant="solid">
        {on ? "TURN OFF" : "TURN ON"}
      </Button>
    </form>
  );
}

/** One agent: its status, and a form that sends the other status. The reason goes to the audit log. */
export function AgentStatusForm({ agentId, status, action }: { agentId: string; status: "active" | "suspended"; action: Action }) {
  const next = status === "active" ? "suspended" : "active";
  return (
    <form action={action}>
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="status" value={next} />
      <input className="input" name="reason" required minLength={OPS.reasonMin} maxLength={OPS.reasonMax} aria-label="Reason" placeholder="Reason" />
      <Button type="submit">{status === "active" ? "SUSPEND" : "REACTIVATE"}</Button>
    </form>
  );
}
