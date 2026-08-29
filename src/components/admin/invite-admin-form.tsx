"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { inviteAdmin, type InviteState } from "@/lib/admin/actions";

export function InviteAdminForm({ roles }: { roles: { key: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(inviteAdmin, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Invitation sent");
      ref.current?.reset();
    }
  }, [state.ok, state.message]);

  return (
    <form ref={ref} action={formAction} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="off"
            placeholder="person@example.com"
            className="field"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Role</span>
          <select name="roleKey" required defaultValue="" className="field">
            <option value="" disabled>
              Choose…
            </option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}
      {state.ok && state.message && (
        <p className="inline-flex items-center gap-1.5 rounded-sm bg-sage-50 px-3 py-2 text-sm text-sage">
          <Check size={14} /> {state.message}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending && <Loader2 size={15} className="animate-spin" />}
        Send invitation
      </button>
    </form>
  );
}
