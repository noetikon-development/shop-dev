"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { cleanUserText } from "@/lib/ugc";
import { hitRateLimit } from "@/lib/rate-limit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSupportInbound, sendSupportAck } from "@/lib/email/notifications";
import { CONTACT_LIMITS, type ContactFormState } from "@/lib/contact-shared";

/**
 * Public contact-form submission (Step 21 P5).
 *
 * - All identity is server-supplied from the form only; there is no
 *   authentication and nothing is trusted beyond the four fields.
 * - Every field is length-checked with zod, then normalised with
 *   `cleanUserText` (control chars stripped, whitespace collapsed). The values
 *   are only ever rendered escaped (email templates call `esc()`), so no markup
 *   or script can survive the round trip.
 * - A hidden honeypot field silently absorbs bots.
 * - Fixed-window rate limiting per IP and per email address (see
 *   `@/lib/rate-limit`) throttles obvious abuse.
 * - Both emails are dispatched via `scheduleEmail` after the response, run
 *   SKIPPED until SMTP is configured, and are idempotent per (email, subject,
 *   message, UTC day).
 * - Responses are deliberately generic — no internal error detail is returned.
 */

const contactSchema = z.object({
  name: z.string().trim().min(CONTACT_LIMITS.nameMin).max(CONTACT_LIMITS.nameMax),
  email: z.string().trim().toLowerCase().max(CONTACT_LIMITS.emailMax).email(),
  subject: z.string().trim().min(CONTACT_LIMITS.subjectMin).max(CONTACT_LIMITS.subjectMax),
  message: z.string().trim().min(CONTACT_LIMITS.messageMin).max(CONTACT_LIMITS.messageMax),
});

const FIELD_MESSAGES: Record<string, string> = {
  name: `Please enter your name (${CONTACT_LIMITS.nameMin}–${CONTACT_LIMITS.nameMax} characters).`,
  email: "Please enter a valid email address.",
  subject: `Please enter a subject (${CONTACT_LIMITS.subjectMin}–${CONTACT_LIMITS.subjectMax} characters).`,
  message: `Please enter a message (${CONTACT_LIMITS.messageMin}–${CONTACT_LIMITS.messageMax} characters).`,
};

const IP_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 }; // 5 / hour / IP
const EMAIL_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 }; // 3 / hour / address

async function clientIp(): Promise<string> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
    return h.get("x-real-ip")?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function submitContactMessage(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  // Honeypot — a real user never fills this hidden field. Absorb silently so a
  // bot gets the same success response and learns nothing.
  if (String(formData.get("company") ?? "").trim() !== "") {
    return { ok: true };
  }

  const parsed = contactSchema.safeParse({
    name: cleanUserText(formData.get("name")),
    email: cleanUserText(formData.get("email")),
    subject: cleanUserText(formData.get("subject")),
    message: cleanUserText(formData.get("message")),
  });

  if (!parsed.success) {
    const fieldErrors: ContactFormState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "name" || key === "email" || key === "subject" || key === "message") {
        fieldErrors[key] ??= FIELD_MESSAGES[key];
      }
    }
    return { ok: false, error: "Please check the highlighted fields.", fieldErrors };
  }

  const { name, email, subject, message } = parsed.data;

  const ip = await clientIp();
  const [ipHit, emailHit] = await Promise.all([
    hitRateLimit(`contact:ip:${ip}`, IP_LIMIT),
    hitRateLimit(`contact:email:${email}`, EMAIL_LIMIT),
  ]);
  if (!ipHit.ok || !emailHit.ok) {
    return {
      ok: false,
      error: "You've sent us a few messages recently. Please wait a little while before sending another.",
    };
  }

  const payload = { name, email, subject, message };
  scheduleEmail(() => sendSupportInbound(payload));
  scheduleEmail(() => sendSupportAck(payload));

  return { ok: true };
}
