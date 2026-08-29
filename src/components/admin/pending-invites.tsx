"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { revokeInvite, type SimpleState } from "@/lib/admin/actions";

type Invite = {
  id: string;
  email: string;
  roleName: string;
  invitedBy: string;
  createdAt: string;
};

function RevokeButton({ inviteId }: { inviteId: string }) {
  const [state, formAction, pending] = useActionState<SimpleState, FormData>(revokeInvite, {});

  useEffect(() => {
    if (state.ok) toast.success("Invitation revoked");
    if (state.error) toast.error(state.error);
  }, [state.ok, state.error]);

  return (
    <form action={formAction}>
      <input type="hidden" name="inviteId" value={inviteId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1 text-sm text-ink-soft underline underline-offset-2 hover:text-clay"
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        Revoke
      </button>
    </form>
  );
}

export function PendingInvites({
  invites,
  canManage,
}: {
  invites: Invite[];
  canManage: boolean;
}) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
            <th className="py-2 pr-4 font-medium">Email</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Invited by</th>
            <th className="py-2 pr-4 font-medium">Sent</th>
            {canManage && <th className="py-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.id} className="border-b border-line/60">
              <td className="py-2.5 pr-4">{i.email}</td>
              <td className="py-2.5 pr-4">{i.roleName}</td>
              <td className="py-2.5 pr-4 text-ink-soft">{i.invitedBy}</td>
              <td className="py-2.5 pr-4 text-ink-soft">{i.createdAt}</td>
              {canManage && (
                <td className="py-2.5">
                  <RevokeButton inviteId={i.id} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
