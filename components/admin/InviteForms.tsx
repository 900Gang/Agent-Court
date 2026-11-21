import { Button } from "@/components/ui/Button";
import { INVITES } from "@/lib/config/constants";
import type { InviteRow, InviteState } from "@/lib/services/inviteService";

type Action = (formData: FormData) => void | Promise<void>;

/** One field: the GitHub login to invite. The server checks it again and asks GitHub who it is. */
export function AddInviteForm({ action }: { action: Action }) {
  return (
    <form action={action}>
      <div className="field">
        <label>
          GitHub login
          <input className="input" name="login" required maxLength={INVITES.maxLoginInput} autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <Button type="submit" variant="solid">
        INVITE
      </Button>
    </form>
  );
}

const STATE_LABEL: Record<InviteState, string> = {
  not_signed_in: "NOT SIGNED IN YET",
  pending: "SIGNED IN, PENDING",
  active: "ACTIVE",
  suspended: "SUSPENDED",
};

const formatTime = (at: Date) => `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;

/** The invite list. Every value is a plain text node; the GitHub id in the form is checked again by the service. */
export function InviteTable({ invites, action }: { invites: InviteRow[]; action: Action }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>GITHUB LOGIN</th>
          <th>GITHUB ID</th>
          <th>INVITED BY</th>
          <th>WHEN</th>
          <th>STATE</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {invites.map((invite) => (
          <tr key={invite.githubId}>
            <td>{invite.githubLogin}</td>
            <td>{invite.githubId}</td>
            <td>{invite.invitedBy ?? "-"}</td>
            <td>{formatTime(invite.createdAt)}</td>
            <td>{STATE_LABEL[invite.state]}</td>
            <td>
              <form action={action}>
                <input type="hidden" name="githubId" value={invite.githubId} />
                <Button type="submit">REMOVE</Button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
