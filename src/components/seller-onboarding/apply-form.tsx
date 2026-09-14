"use client";

import { useActionState } from "react";
import {
  submitSellerApplicationAction,
  type SellerApplicationActionState,
} from "@/lib/seller-onboarding/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function SellerApplyForm() {
  const [state, formAction, pending] = useActionState<SellerApplicationActionState, FormData>(
    submitSellerApplicationAction,
    {},
  );

  if (state.ok) {
    return (
      <div className="rounded-lg border border-line-strong bg-surface p-6">
        <p className="font-display text-lg">Application submitted</p>
        <p className="mt-2 text-sm text-ink-soft">
          Thanks — we've received your application and it's under review. We'll email you once
          there's a decision.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="max-w-md space-y-4">
      <Field
        label="Display name"
        name="displayName"
        required
        minLength={2}
        maxLength={80}
        placeholder="e.g. Style Avenue"
        hint="Shown to customers as “Sold by …”."
      />
      <Field
        label="Store slug"
        name="slug"
        required
        minLength={3}
        maxLength={40}
        placeholder="e.g. style-avenue"
        hint="Lowercase letters, numbers and single dashes only."
      />
      <Field
        label="Support email"
        name="supportEmail"
        type="email"
        required
        maxLength={200}
        placeholder="you@yourstore.com"
        hint="Where customers can reach you about their orders."
      />

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <Button type="submit" loading={pending}>
        Submit application
      </Button>
    </form>
  );
}
