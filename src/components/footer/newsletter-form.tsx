"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-success">
        <Check size={16} /> Thanks — check your inbox for the code.
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
        aria-label="Email address"
      />
      <button type="submit" className="btn btn-primary shrink-0 !px-3.5 !py-2.5" aria-label="Subscribe">
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
