import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEmailConfig } from "@/lib/email/config";
import { getTransport } from "@/lib/email/transport";

/** DB client for the EmailLog bookkeeping. Defaults to the module client; a
 *  transaction client can be threaded in so an automated test rolls back. It
 *  never changes what any existing caller does (they don't pass one). */
type LogClient = Prisma.TransactionClient | typeof prisma;

/**
 * Central email dispatch (Step 17).
 *
 * Idempotency: every send has a deterministic `idempotencyKey` (e.g.
 * "ORDER_CREATED:<orderId>"). The `EmailLog.idempotencyKey` column is UNIQUE, so
 * the first thing this does is INSERT the log row — a duplicate key means the
 * email was already handled and we return without sending anything.
 *
 * Failure isolation: a provider error is caught, recorded on the log row
 * (status FAILED) and swallowed. This function NEVER throws — the caller's
 * business transaction (order creation, status change) is already committed and
 * must not be affected by email delivery.
 */

export type EmailType =
  | "order_confirmation"
  | "order_processing"
  | "order_shipped"
  | "out_for_delivery"
  | "order_delivered"
  | "order_cancelled"
  | "welcome"
  | "password_changed"
  | "email_changed"
  | "sign_in_alert"
  | "support_inbound"
  | "support_ack"
  | "return_requested"
  | "return_inbound"
  | "return_approved"
  | "return_rejected"
  | "return_received"
  | "return_refund_initiated"
  | "return_refund_completed"
  | "payment_confirmation"
  | "refund_issued"
  | "refund_completed"
  | "email_verification"
  | "password_reset"
  | "seller_product_request_submitted"
  | "seller_product_request_approved"
  | "seller_product_request_rejected"
  | "seller_account_approved"
  | "seller_account_suspended"
  | "seller_account_closed"
  | "seller_profile_submitted"
  | "seller_profile_approved"
  | "seller_profile_rejected"
  | "order_received_ops"
  | "seller_order_cancelled"
  | "seller_return_received"
  | "return_refund_initiated_ops"
  | "return_refund_completed_ops";

export type DispatchInput = {
  type: EmailType;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  userId?: string | null;
  orderId?: string | null;
  /**
   * Preferred envelope-from for this message (e.g. "no-reply@axiaro.shop" for
   * account-security notices). Ignored when EMAIL_FROM is pinned for the
   * deployment — the provider's verified sender always wins there.
   */
  from?: string;
  /**
   * Preferred Reply-To for this message (e.g. the customer's address on a
   * support notification so the team can reply straight back). Falls back to
   * the global EMAIL_REPLY_TO.
   */
  replyTo?: string;
  /** Admin-initiated re-send: reuse an existing FAILED / SKIPPED log row. */
  retry?: boolean;
  /** Optional transaction client for the EmailLog bookkeeping (tests only). */
  client?: Prisma.TransactionClient;
};

export type DispatchResult = {
  ok: boolean;
  deduped?: boolean;
  skipped?: boolean;
  status: "SENT" | "FAILED" | "SKIPPED" | "DEDUPED";
  error?: string;
};

const MAX_ERROR_LEN = 500;

/**
 * Record a FAILED EmailLog row for a message that could not even be BUILT — a
 * template-render exception, so `dispatchEmail` was never reached. Keeps the
 * failure visible in `/admin/email` instead of only in the server log. Never
 * sends, never throws.
 *
 * Reuses the deterministic idempotency key: if a row for that key already
 * exists and is still recoverable (SENT / SENDING / PENDING), it is left alone
 * so a later real send can still go out; a prior FAILED / SKIPPED row is
 * refreshed with the new render error.
 */
export async function recordEmailFailure(input: {
  type: EmailType;
  to: string;
  idempotencyKey: string;
  error: string;
  userId?: string | null;
  orderId?: string | null;
  client?: Prisma.TransactionClient;
}): Promise<DispatchResult> {
  const db: LogClient = input.client ?? prisma;
  const error = input.error.slice(0, MAX_ERROR_LEN);
  try {
    const res = await db.emailLog.createMany({
      data: [
        {
          type: input.type,
          recipient: input.to,
          subject: "(message not generated — template render failed)",
          idempotencyKey: input.idempotencyKey,
          status: "FAILED",
          error,
          userId: input.userId ?? null,
          orderId: input.orderId ?? null,
        },
      ],
      skipDuplicates: true,
    });
    if (res.count === 0) {
      await db.emailLog
        .updateMany({
          where: { idempotencyKey: input.idempotencyKey, status: { in: ["FAILED", "SKIPPED"] } },
          data: { status: "FAILED", error },
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error("[email] could not record render failure", input.type, err);
  }
  return { ok: false, status: "FAILED", error };
}

export async function dispatchEmail(input: DispatchInput): Promise<DispatchResult> {
  const db: LogClient = input.client ?? prisma;
  // 1. Claim the idempotency key. `createMany({ skipDuplicates: true })` is
  //    concurrency-safe (the UNIQUE constraint decides) and — unlike `create` —
  //    does not throw / log a query error when the key already exists.
  let logId: string;
  try {
    const res = await db.emailLog.createMany({
      data: [
        {
          type: input.type,
          recipient: input.to,
          subject: input.subject.slice(0, 500),
          idempotencyKey: input.idempotencyKey,
          status: "PENDING",
          userId: input.userId ?? null,
          orderId: input.orderId ?? null,
        },
      ],
      skipDuplicates: true,
    });

    if (res.count === 0) {
      // The key already exists — this email was already handled.
      if (!input.retry) return { ok: true, deduped: true, status: "DEDUPED" };
      const existing = await db.emailLog.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true },
      });
      if (!existing || ["SENT", "SENDING", "PENDING"].includes(existing.status)) {
        return { ok: true, deduped: true, status: "DEDUPED" };
      }
      logId = existing.id;
      await db.emailLog
        .update({ where: { id: logId }, data: { subject: input.subject.slice(0, 500), error: null } })
        .catch(() => {});
    } else {
      const row = await db.emailLog.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      logId = row.id;
    }
  } catch (err) {
    console.error("[email] could not record EmailLog", input.type, err);
    return { ok: false, status: "FAILED", error: "log_write_failed" };
  }

  const cfg = getEmailConfig();
  const transport = getTransport();

  // 2. Not configured (no SMTP creds, or EMAIL_MODE=log) → record SKIPPED.
  if (!cfg.configured || !transport) {
    await db.emailLog
      .update({
        where: { id: logId },
        data: {
          status: "SKIPPED",
          provider: "smtp",
          error: cfg.mode === "log" ? "email_mode_log" : "smtp_not_configured",
        },
      })
      .catch(() => {});
    return { ok: true, skipped: true, status: "SKIPPED" };
  }

  // 3. Attempt the send.
  await db.emailLog
    .update({ where: { id: logId }, data: { status: "SENDING", attempts: { increment: 1 } } })
    .catch(() => {});

  // Envelope-from: a per-message preference (e.g. no-reply@ for security mail)
  // unless the deployment pinned EMAIL_FROM, in which case that verified sender
  // always wins.
  const fromAddr = cfg.fromPinned ? cfg.from : (input.from || cfg.from);
  const replyToAddr = input.replyTo || cfg.replyTo;

  try {
    const info = await transport.sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${fromAddr}>` : fromAddr,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...(replyToAddr ? { replyTo: replyToAddr } : {}),
    });
    await db.emailLog
      .update({
        where: { id: logId },
        data: {
          status: "SENT",
          provider: "smtp",
          providerMessageId: (info.messageId ?? "").slice(0, 200) || null,
          sentAt: new Date(),
          error: null,
        },
      })
      .catch(() => {});
    return { ok: true, status: "SENT" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.emailLog
      .update({
        where: { id: logId },
        data: { status: "FAILED", provider: "smtp", error: message.slice(0, MAX_ERROR_LEN) },
      })
      .catch(() => {});
    console.error("[email] send failed", input.type, message);
    return { ok: false, status: "FAILED", error: message };
  }
}
