"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";

/**
 * First-order discount prompt (footer).
 *
 * This is a demo store: no marketing list is maintained and no email is sent or
 * stored. Submitting simply reveals the real, active WELCOME10 promo code so the
 * message is accurate about what actually happens.
 */
export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-success">
        <Check size={16} /> Use code <span className="font-medium">WELCOME10</span> at checkout for
        10% off your first order.
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
      <button
        type="submit"
        className="btn btn-primary shrink-0 !px-3.5 !py-2.5"
        aria-label="Get my discount code"
      >
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
