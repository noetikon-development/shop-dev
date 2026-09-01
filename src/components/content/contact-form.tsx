"use client";

import { useActionState, useEffect, useRef } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { submitContactMessage } from "@/lib/contact-actions";
import { CONTACT_LIMITS, type ContactFormState } from "@/lib/contact-shared";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

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
          <Field
            label="Name"
            type="text"
            name="name"
            required
            maxLength={CONTACT_LIMITS.nameMax}
            autoComplete="name"
            error={fieldError("name")}
          />
          <Field
            label="Email"
            type="email"
            name="email"
            required
            maxLength={CONTACT_LIMITS.emailMax}
            autoComplete="email"
            error={fieldError("email")}
          />
        </div>

        <Field
          label="Subject"
          type="text"
          name="subject"
          required
          minLength={CONTACT_LIMITS.subjectMin}
          maxLength={CONTACT_LIMITS.subjectMax}
          error={fieldError("subject")}
        />

        <Field label="Message" error={fieldError("message")}>
          {(control) => (
            <textarea
              {...control}
              name="message"
              required
              rows={6}
              minLength={CONTACT_LIMITS.messageMin}
              maxLength={CONTACT_LIMITS.messageMax}
              className="field resize-y"
            />
          )}
        </Field>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <Button type="submit" loading={pending}>
          Send message
        </Button>
      </form>
    </section>
  );
}
