import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getEmailConfig } from "@/lib/email/config";

/**
 * Lazily-created nodemailer SMTP transport (Step 17). Provider-agnostic: any
 * transactional provider that speaks SMTP (Resend, SendGrid, Postmark, Mailgun,
 * SES, …) works by setting the EMAIL_* environment variables. Returns null when
 * SMTP is not configured — callers then record a SKIPPED EmailLog instead of
 * sending.
 */

let cached: Transporter | null = null;
let cachedKey = "";

export function getTransport(): Transporter | null {
  const cfg = getEmailConfig();
  if (!cfg.configured) return null;

  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cached && cachedKey === key) return cached;

  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure, // 465 = implicit TLS; 587/25 = STARTTLS
    auth: { user: cfg.user, pass: cfg.password },
    // Force TLS even on the STARTTLS ports.
    requireTLS: !cfg.secure,
  });
  cachedKey = key;
  return cached;
}
