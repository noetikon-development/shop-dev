"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * First-order discount prompt (footer).
 *
 * There is no newsletter backend: no marketing list is stored and no email is
 * sent. Submitting simply reveals the configured message (by default the real,
 * active WELCOME10 promo code) so the copy is accurate about what happens. The
 * wording is editable in Admin → Content → Footer.
 */
export function NewsletterForm({
  ctaLabel = "",
  successText = "Use code WELCOME10 at checkout for 10% off your first order.",
}: {
  ctaLabel?: string;
  successText?: string;
}) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-success">
        <Check size={16} className="shrink-0" /> {successText}
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (email.includes("@")) setDone(true);
      }}
      className="flex max-w-sm items-center gap-2"
    >
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email address"
        className="field !py-2.5"
        aria-label="Email address for your first-order discount code"
      />
      <Button
        type="submit"
        size="sm"
        className="shrink-0"
        aria-label={ctaLabel || "Get my discount code"}
      >
        {ctaLabel ? <span>{ctaLabel}</span> : <ArrowRight size={16} />}
      </Button>
    </form>
  );
}
