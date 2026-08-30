import "server-only";
import { SITE } from "@/lib/constants";

/**
 * Transactional-email configuration (Step 17).
 *
 * Everything comes from server-side environment variables — no value here is
 * ever prefixed `NEXT_PUBLIC_` or sent to the browser. If the SMTP host / user /
 * password are not all set, the service runs in "not configured" mode: it still
 * records an `EmailLog` row (status SKIPPED) so the pipeline is observable, but
 * it never attempts a real send. This is deliberate for the demo — no
 * credentials are invented.
 *
 * `EMAIL_MODE=log` forces the same skip behaviour even when SMTP is configured
 * (an explicit local/QA switch). Production email is never silently redirected
 * to a test address.
 */

export type EmailMode = "live" | "log";

export type EmailConfig = {
  configured: boolean;
  mode: EmailMode;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  fromName: string;
  replyTo: string | null;
};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getEmailConfig(): EmailConfig {
  const host = (process.env.EMAIL_HOST ?? "").trim();
  const user = (process.env.EMAIL_USER ?? "").trim();
  const password = process.env.EMAIL_PASSWORD ?? "";
  const port = num(process.env.EMAIL_PORT, 587);

  const modeEnv = (process.env.EMAIL_MODE ?? "").trim().toLowerCase();
  const mode: EmailMode = modeEnv === "log" ? "log" : "live";

  const hasCreds = Boolean(host && user && password);
  const configured = hasCreds && mode === "live";

  return {
    configured,
    mode,
    host,
    port,
    // Port 465 → implicit TLS; otherwise STARTTLS is negotiated on 587/25.
    secure: port === 465,
    user,
    password,
    from: (process.env.EMAIL_FROM ?? user ?? "").trim(),
    fromName: (process.env.EMAIL_FROM_NAME ?? SITE.brand).trim(),
    replyTo: (process.env.EMAIL_REPLY_TO ?? "").trim() || null,
  };
}

/** True when a real SMTP send can be attempted. */
export function isEmailConfigured(): boolean {
  return getEmailConfig().configured;
}
