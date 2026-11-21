import { AddInviteForm, InviteTable } from "@/components/admin/InviteForms";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { loadInvitesPage } from "@/lib/admin/inviteData";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeError } from "@/lib/dashboard/messages";
import { addInviteFormAction, removeInviteFormAction } from "../actions";

// Only a short run of digits is ever shown back from the address; anything else in it is ignored.
const digits = (value: string | undefined) => (typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? value : null);

export default async function InvitesPage({ searchParams }: { searchParams: Promise<{ error?: string; added?: string; exists?: string; removed?: string }> }) {
  await requireAdmin(); // the layout checks too; a page never relies on its parent alone
  const { error, added, exists, removed } = await searchParams;
  const { inviteOnly, invites } = await loadInvitesPage();
  const problem = error ? describeError(error) : null;
  const byId = new Map(invites.map((invite) => [invite.githubId, invite]));
  const addedRow = byId.get(digits(added) ?? "");
  const existsRow = byId.get(digits(exists) ?? "");

  return (
    <>
      <h1>INVITES</h1>
      <p className="hint">
        {inviteOnly
          ? "This deployment is invite-only: only a GitHub account on this list can become an operator, as long as it also passes the usual checks."
          : "This deployment is not invite-only, so everyone who passes the usual checks can become an operator. The list does nothing until the INVITE_ONLY setting is on."}
      </p>
      {problem ? <ErrorBlock code={problem.code} message={problem.message} hint={problem.hint} /> : null}
      {addedRow ? <Notice>{`Invited ${addedRow.githubLogin} (GitHub id ${addedRow.githubId}). They become an operator when they next sign in.`}</Notice> : null}
      {existsRow ? <Notice>{`${existsRow.githubLogin} (GitHub id ${existsRow.githubId}) was already invited. Nothing changed.`}</Notice> : null}
      {digits(removed) ? <Notice>Invite removed. An operator who is already active is not affected; suspend them from the kill switch page if needed.</Notice> : null}

      <h2>INVITE A GITHUB ACCOUNT</h2>
      <p className="hint">Type the GitHub login. The server asks GitHub which account it is and stores its id, so a rename does not matter.</p>
      <AddInviteForm action={addInviteFormAction} />

      <h2>INVITED ({invites.length})</h2>
      {invites.length === 0 ? <p className="muted">Nobody has been invited yet.</p> : <InviteTable invites={invites} action={removeInviteFormAction} />}
    </>
  );
}
