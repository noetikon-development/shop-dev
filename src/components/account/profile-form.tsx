"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateProfile, type ProfileState } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function ProfileForm({
  name,
  phone,
}: {
  name: string;
  phone: string;
}) {
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(updateProfile, {});

  useEffect(() => {
    if (state.ok) toast.success("Profile updated");
  }, [state.ok]);

  return (
    <form action={formAction} className="max-w-md space-y-4">
      <Field label="Full name" name="name" required defaultValue={name} autoComplete="name" />
      <Field
        label="Phone number"
        name="phone"
        type="tel"
        defaultValue={phone}
        autoComplete="tel"
        placeholder="+63 9XX XXX XXXX"
      />

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <Button type="submit" loading={pending}>
        Save changes
      </Button>
    </form>
  );
}
