"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { updateProfile, type ProfileState } from "@/lib/auth-actions";

export function ProfileForm({
  name,
  phone,
  email,
}: {
  name: string;
  phone: string;
  email: string;
}) {
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(updateProfile, {});

  useEffect(() => {
    if (state.ok) toast.success("Profile updated");
  }, [state.ok]);

  return (
    <form action={formAction} className="max-w-md space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Full name</span>
        <input
          name="name"
          required
          defaultValue={name}
          autoComplete="name"
          className="field"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Email</span>
        <input value={email} disabled className="field bg-surface-sunken text-ink-faint" />
        <span className="mt-1 block text-xs text-ink-faint">
          Contact support to change the email on your account.
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Phone number</span>
        <input
          name="phone"
          type="tel"
          defaultValue={phone}
          autoComplete="tel"
          placeholder="+63 9XX XXX XXXX"
          className="field"
        />
      </label>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending && <Loader2 size={15} className="animate-spin" />}
        Save changes
      </button>
    </form>
  );
}
