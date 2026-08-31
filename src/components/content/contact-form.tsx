"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { submitContactMessage } from "@/lib/contact-actions";
import { CONTACT_LIMITS, type ContactFormState } from "@/lib/contact-shared";

/**
 * Public contact form for /pages/contact (Step 21 P5). Identity is never trusted
 * from the client — the server action re-validates every field, rate-limits, and
 * sends the support + acknowledgement emails. The hidden "company" field is a
 * honeypot.
 */
export function ContactForm() {
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(
    submitContactMessage,
    {},
  );
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success("Message sent — we'll be in touch.");
      ref.current?.reset();
    }
  }, [state.ok]);

  const fieldError = (name: "name" | "email" | "subject" | "message") =>
    state.fieldErrors?.[name];

  return (
    <section
      aria-labelledby="contact-form-heading"
      className="mt-10 rounded-lg border border-line bg-surface p-6 sm:p-8"
    >
      <h2 id="contact-form-heading" className="font-display text-xl text-ink">
        Send us a message
      </h2>
      <p className="mt-2 text-[15px] text-ink-soft">
        Fill in the form and we&apos;ll reply by email, usually within 1–2 business days.
      </p>

      {state.ok ? (
        <div
          role="status"
          className="mt-5 flex items-start gap-3 rounded-md border border-line bg-surface-sunken/50 p-4 text-[15px] text-ink-soft"
        >
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ink" aria-hidden />
          <span>
            Thanks for reaching out. We&apos;ve received your message and sent a confirmation
            to your email address.
          </span>
        </div>
      ) : null}

      <form ref={ref} action={formAction} className="mt-5 space-y-4" noValidate>
        {/* Honeypot: visually hidden, not announced, never filled by humans. */}
        <div aria-hidden className="hidden">
          <label>
            Company
            <input type="text" name="company" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Name</span>
            <input
              type="text"
              name="name"
              required
              maxLength={CONTACT_LIMITS.nameMax}
              autoComplete="name"
              className="field"
              aria-invalid={fieldError("name") ? true : undefined}
            />
            {fieldError("name") && (
              <span className="mt-1 block text-xs text-clay">{fieldError("name")}</span>
            )}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Email</span>
            <input
              type="email"
              name="email"
              required
              maxLength={CONTACT_LIMITS.emailMax}
              autoComplete="email"
              className="field"
              aria-invalid={fieldError("email") ? true : undefined}
            />
            {fieldError("email") && (
              <span className="mt-1 block text-xs text-clay">{fieldError("email")}</span>
            )}
          </label>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Subject</span>
          <input
            type="text"
            name="subject"
            required
            minLength={CONTACT_LIMITS.subjectMin}
            maxLength={CONTACT_LIMITS.subjectMax}
            className="field"
            aria-invalid={fieldError("subject") ? true : undefined}
          />
          {fieldError("subject") && (
            <span className="mt-1 block text-xs text-clay">{fieldError("subject")}</span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Message</span>
          <textarea
            name="message"
            required
            rows={6}
            minLength={CONTACT_LIMITS.messageMin}
            maxLength={CONTACT_LIMITS.messageMax}
            className="field resize-y"
            aria-invalid={fieldError("message") ? true : undefined}
          />
          {fieldError("message") && (
            <span className="mt-1 block text-xs text-clay">{fieldError("message")}</span>
          )}
        </label>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending && <Loader2 size={15} className="animate-spin" />}
          Send message
        </button>
      </form>
    </section>
  );
}
