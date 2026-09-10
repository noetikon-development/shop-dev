import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** The webhook handlers accept the global client (production) or a transaction
 *  client (rolled-back tests) — identical to `recordSettlement` /
 *  `confirmCodPaymentReceived` / `saveSellerShipment`. With the default `prisma`
 *  each handler opens its own `$transaction` exactly as before; with a passed tx
 *  the handler runs inside it. No state-machine logic changes. */
type Db = Prisma.TransactionClient | typeof prisma;
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendPaymentConfirmation, sendRefundCompleted } from "@/lib/email/notifications";
import { getPaymentsConfig } from "@/lib/payments/config";
import { verifyWebhookSignature } from "@/lib/payments/paymongo";
import {
  isHandledWebhookType,
  orderPaymentMethodFromProvider,
  canTransitionPayment,
} from "@/lib/payments/status";

/**
 * PayMongo webhook processing (Step 21 P4; `checkout_session.payment.paid`
 * handler completed in Phase 6C).
 *
 * The route (`/api/webhooks/paymongo`) is a thin wrapper: read the raw body,
 * hand it here, translate the result to a status code. All security + state
 * logic lives in this server-only module.
 *
 * Gating: this handler drives the order state machine only when
 * `getPaymentsConfig().onlinePaymentEnabled` is true — which needs the setting
 * AND `PAYMONGO_SECRET_KEY` AND `PAYMONGO_WEBHOOK_SECRET` AND a consistent
 * test/live mode. If `PAYMONGO_WEBHOOK_SECRET` is absent `verifyWebhookSignature`
 * fails closed → 401 for every request. If a signature verifies but the feature
 * is off, the event is recorded + marked IGNORED with no state change.
 *
 * Trust model: the event tells us WHICH provider object changed. We then
 * re-read our own Payment / Order rows and verify the CAPTURED amount +
 * currency (taken from the payload's `payments[]` / `payment_intent`, never
 * assumed) match our snapshot AND the live order total before any state change.
 * We never trust an amount, status or order reference straight from the payload.
 */

export type WebhookResult = {
  status: number; // HTTP status the route should return
  body: string; // short, non-sensitive
};

const OK: WebhookResult = { status: 200, body: "ok" };

/** Parsed PayMongo webhook envelope (only the fields we use). */
type PaymongoEvent = {
  data?: {
    id?: string;
    attributes?: {
      type?: string;
      data?: {
        id?: string;
        type?: string;
        attributes?: Record<string, unknown>;
      };
    };
  };
};

export async function processPaymongoWebhook(
  rawBody: string,
  signatureHeader: string | null,
  opts: { isHttps: boolean },
): Promise<WebhookResult> {
  if (!opts.isHttps) return { status: 400, body: "https required" };

  const config = await getPaymentsConfig();

  // 1. Signature FIRST — before any parse, any DB write, any logging of content.
  const sig = verifyWebhookSignature(
    rawBody,
    signatureHeader,
    (process.env.PAYMONGO_WEBHOOK_SECRET ?? "").trim(),
    config.mode,
  );
  if (!sig.ok) {
    // No body / header logged. Only the coarse reason.
    console.warn("[paymongo-webhook] signature rejected:", sig.reason);
    return { status: 401, body: "signature verification failed" };
  }

  // 2. Parse (safe now that the payload is authenticated).
  let event: PaymongoEvent;
  try {
    event = JSON.parse(rawBody) as PaymongoEvent;
  } catch {
    return { status: 400, body: "malformed payload" };
  }

  const providerId = event.data?.id;
  const type = event.data?.attributes?.type;
  if (!providerId || !type || typeof providerId !== "string" || typeof type !== "string") {
    return { status: 400, body: "missing event id or type" };
  }

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");

  // 3. Claim the event id. Unique constraint = replay / duplicate protection.
  //    The raw body is stored ALONGSIDE the claim (it is already
  //    signature-verified at this point) so a FAILED event can be reprocessed
  //    through the same idempotent handler — see `reprocessWebhookEvent`.
  let claimed = false;
  try {
    const res = await prisma.webhookEvent.createMany({
      data: [{ providerId, type, payloadHash, payload: rawBody, status: "RECEIVED" }],
      skipDuplicates: true,
    });
    claimed = res.count === 1;
  } catch (err) {
    console.error("[paymongo-webhook] could not record event", type, err);
    return { status: 500, body: "temporary error" }; // provider will retry
  }

  if (!claimed) {
    // Already seen. A tampered re-send of a known id would carry a different
    // hash — flag it, but still 200 so the provider stops.
    const existing = await prisma.webhookEvent.findUnique({
      where: { providerId },
      select: { payloadHash: true, status: true },
    });
    if (existing && existing.payloadHash !== payloadHash) {
      console.warn("[paymongo-webhook] duplicate event id with mismatched payload:", providerId);
    }
    return { status: 200, body: "duplicate — already processed" };
  }

  // 4. Unknown type → acknowledge + IGNORE (provider stops retrying).
  if (!isHandledWebhookType(type)) {
    await markEvent(providerId, "IGNORED", "unhandled event type");
    return { status: 200, body: "ignored (unhandled type)" };
  }

  // 5. Feature disabled (Phase 4-A) → record + IGNORE, no state change.
  if (!config.onlinePaymentEnabled) {
    await markEvent(providerId, "IGNORED", "online payment disabled");
    return { status: 200, body: "ignored (feature disabled)" };
  }

  // 6. Dispatch. Any thrown error → mark FAILED, 200 (so the provider does not
  //    hammer us) — reconciliation handles genuinely missed events.
  try {
    await handleEvent(providerId, type, event);
    await markEvent(providerId, "PROCESSED", null);
    return OK;
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : "handler error";
    console.error("[paymongo-webhook] handler failed:", type, reason);
    await markEvent(providerId, "FAILED", reason);
    // 200: don't invite a retry storm. A FAILED WebhookEvent is visible in
    // /admin/payments for manual reconciliation.
    return { status: 200, body: "recorded (handler error)" };
  }
}

async function markEvent(
  providerId: string,
  status: string,
  error: string | null,
  db: Db = prisma,
): Promise<void> {
  await db.webhookEvent
    .update({
      where: { providerId },
      data: { status, error, processedAt: new Date() },
    })
    .catch(() => {});
}

/** Merge fields into a Payment.metadata JSON string. Undefined values are
 *  dropped; a malformed existing value is treated as {}. Never throws. */
export function mergeMetadata(existing: string | null | undefined, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = existing ? JSON.parse(existing) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) base[k] = v;
  }
  return JSON.stringify(base);
}

/**
 * 9F-54 — reprocess a FAILED `WebhookEvent` through the SAME idempotent handler.
 *
 * The permission check (`manage_payments`) lives in the thin server action
 * (`reprocessWebhookEventAction`); this core takes an explicit `actor`.
 *
 * Safe by construction — it does NOT re-claim the event (the row already
 * exists), and every handler is status-guarded (`canTransitionPayment` +
 * status-scoped `updateMany` with a count check), so re-running a handler that
 * partially succeeded, or one whose work is already done, is a no-op. It never
 * creates a second Payment / OrderEvent / AdminAuditLog for the same effect.
 *
 * Only FAILED events with a stored raw `payload` are eligible. IGNORED (feature
 * off / unknown type) and PROCESSED events are refused — reprocessing them would
 * be meaningless or unsafe.
 */
export type ReprocessResult =
  | { ok: true; outcome: "PROCESSED" | "already_current" }
  | { ok: false; code: "NOT_FOUND" | "NOT_FAILED" | "NO_PAYLOAD" | "FEATURE_OFF" | "HANDLER_ERROR"; error: string };

export async function reprocessWebhookEvent(
  webhookEventId: string,
  actor: { userId: string; email: string },
  db: Db = prisma,
): Promise<ReprocessResult> {
  const row = await db.webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { id: true, providerId: true, type: true, status: true, payload: true, payloadHash: true },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", error: "No such webhook event." };
  if (row.status !== "FAILED") {
    return { ok: false, code: "NOT_FAILED", error: `Only a FAILED event can be reprocessed (this one is ${row.status}).` };
  }
  if (!row.payload) {
    return { ok: false, code: "NO_PAYLOAD", error: "No stored payload — resend this event from the PayMongo dashboard instead." };
  }

  const config = await getPaymentsConfig();
  if (!config.onlinePaymentEnabled) {
    return { ok: false, code: "FEATURE_OFF", error: "Online payment is not enabled — nothing to reprocess." };
  }

  let event: PaymongoEvent;
  try {
    event = JSON.parse(row.payload) as PaymongoEvent;
  } catch {
    return { ok: false, code: "NO_PAYLOAD", error: "Stored payload is not valid JSON." };
  }

  const txClient = db === prisma ? undefined : (db as Prisma.TransactionClient);
  await db.webhookEvent.update({ where: { id: row.id }, data: { reprocessedAt: new Date() } }).catch(() => {});

  try {
    await handleEvent(row.providerId, row.type, event, db);
    await markEvent(row.providerId, "PROCESSED", null, db);
    await writeAudit(
      {
        actorUserId: actor.userId,
        action: "payment.webhook_reprocessed",
        targetType: "webhook_event",
        targetId: row.id,
        summary: `${actor.email} reprocessed FAILED webhook ${row.providerId} (${row.type}) → PROCESSED`,
        meta: { providerId: row.providerId, type: row.type },
      },
      txClient,
    );
    return { ok: true, outcome: "PROCESSED" };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : "handler error";
    await markEvent(row.providerId, "FAILED", reason, db);
    await writeAudit(
      {
        actorUserId: actor.userId,
        action: "payment.webhook_reprocess_failed",
        targetType: "webhook_event",
        targetId: row.id,
        summary: `${actor.email} reprocessed FAILED webhook ${row.providerId} (${row.type}) — still failing`,
        meta: { providerId: row.providerId, type: row.type, reason },
      },
      txClient,
    );
    return { ok: false, code: "HANDLER_ERROR", error: reason };
  }
}

// ---------------------------------------------------------------------------
// Handlers — Phase 4-B onward. Each re-reads our own rows and validates
// amount/currency/order before any state change.
// ---------------------------------------------------------------------------

/**
 * Apply a signature-verified webhook event to Axiaro's own rows. Exported so a
 * rolled-back test can drive it with a transaction client; production reaches it
 * only through `processPaymongoWebhook` (after signature + claim + gate).
 */
export async function handleEvent(
  eventId: string,
  type: string,
  event: PaymongoEvent,
  db: Db = prisma,
): Promise<void> {
  const obj = event.data?.attributes?.data;
  const objId = obj?.id;
  const attrs = obj?.attributes ?? {};
  if (!objId) throw new Error("event object has no id");

  switch (type) {
    case "checkout_session.payment.paid":
    case "payment.paid":
      return applyPaid(eventId, type, objId, attrs, db);
    case "payment.failed":
      return applyFailed(eventId, objId, attrs, db);
    case "checkout_session.expired":
      return applyExpired(eventId, objId, db);
    case "refund.updated":
      return applyRefundUpdate(eventId, objId, attrs, db);
  }
}

type ProviderFields = {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  source?: { type?: unknown } | null;
  payment_method_used?: unknown;
  method?: unknown;
};
/** A nested PayMongo resource may be flat (`{ amount }`) or wrapped
 *  (`{ id, type, attributes: { amount } }`). Read either shape. */
type ProviderPayObj = ProviderFields & { attributes?: ProviderFields };

export const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Merge a possibly-wrapped resource down to a flat field bag (own > attributes). */
function flat(o: ProviderPayObj | undefined): ProviderFields & { id?: unknown } {
  if (!o) return {};
  const a = o.attributes ?? {};
  return {
    id: o.id ?? undefined,
    amount: o.amount ?? a.amount,
    currency: o.currency ?? a.currency,
    status: o.status ?? a.status,
    source: o.source ?? a.source ?? null,
    payment_method_used: o.payment_method_used ?? a.payment_method_used,
    method: o.method ?? a.method,
  };
}

/**
 * The captured amount / currency / method for a `*.paid` event.
 *
 * `payment.paid` — `attrs` IS the payment object.
 * `checkout_session.payment.paid` — `attrs` is the session; the captured payment
 *   is nested in `attrs.payments[]` (or `attrs.payment_intent.payments[]`).
 * We ALWAYS take the amount from what PayMongo says it captured and then check
 * it against our own snapshot + the live order total — never the reverse.
 */
export function extractPaidFacts(type: string, attrs: Record<string, unknown>): {
  amount: number | null;
  currency: string | null;
  method: string | null;
  providerPaymentId: string | null;
} {
  if (type === "payment.paid") {
    const f = flat(attrs as ProviderPayObj);
    const source = f.source as { type?: unknown } | undefined;
    return {
      amount: num(f.amount),
      currency: str(f.currency),
      method: str(source?.type) ?? str(f.payment_method_used) ?? str(f.method),
      providerPaymentId: str(f.id) ?? str(attrs.id),
    };
  }
  const piRaw = attrs.payment_intent as ProviderPayObj | undefined;
  const pi = flat(piRaw);
  const piPayments = (piRaw?.attributes as { payments?: ProviderPayObj[] } | undefined)?.payments ?? [];
  const pool: ProviderPayObj[] = [
    ...((attrs.payments as ProviderPayObj[] | undefined) ?? []),
    ...piPayments,
  ].map((p) => ({ ...flat(p) }));
  const paid = pool.find((p) => String(p.status).toLowerCase() === "paid") ?? pool[0];
  return {
    amount: num(paid?.amount) ?? num(pi.amount),
    currency: str(paid?.currency) ?? str(pi.currency),
    method: str((paid?.source as { type?: unknown } | undefined)?.type),
    providerPaymentId: str(paid?.id),
  };
}

/** Find the Payment for a provider event: by any provider id present in the
 *  payload (session id, payment intent id, nested payment ids), falling back to
 *  our own `payment_id` carried in the session metadata. */
async function findPayment(objId: string, attrs: Record<string, unknown>, db: Db) {
  const include = {
    order: { select: { id: true, orderNumber: true, status: true, grandTotal: true } },
  } as const;

  const candidates = new Set<string>([objId]);
  const nested = attrs.payment_intent_id ?? attrs.checkout_session_id;
  if (typeof nested === "string") candidates.add(nested);
  const pi = attrs.payment_intent as ProviderPayObj | undefined;
  if (typeof pi?.id === "string") candidates.add(pi.id);
  const payments: ProviderPayObj[] = [
    ...((attrs.payments as ProviderPayObj[] | undefined) ?? []),
    ...((pi?.attributes as { payments?: ProviderPayObj[] } | undefined)?.payments ?? []),
  ];
  for (const p of payments) {
    const id = p.id ?? p.attributes?.id;
    if (typeof id === "string") candidates.add(id);
  }

  const byProvider = await db.payment.findFirst({
    where: { providerId: { in: [...candidates] } },
    include,
  });
  if (byProvider) return byProvider;

  const ourId = (attrs.metadata as { payment_id?: unknown } | undefined)?.payment_id;
  if (typeof ourId === "string" && ourId) {
    return db.payment.findFirst({ where: { id: ourId }, include });
  }
  return null;
}

async function applyPaid(
  eventId: string,
  type: string,
  objId: string,
  attrs: Record<string, unknown>,
  db: Db,
): Promise<void> {
  const payment = await findPayment(objId, attrs, db);
  if (!payment) throw new Error(`no Payment for provider object ${objId}`);
  if (payment.order.status === "CANCELLED") {
    throw new Error(`order ${payment.order.orderNumber} is cancelled — manual review`);
  }

  const facts = extractPaidFacts(type, attrs);
  if (facts.amount == null) throw new Error("paid event carried no captured amount");
  // The amount PayMongo captured must match BOTH our snapshot AND the live order.
  if (facts.amount !== payment.amount || facts.amount !== payment.order.grandTotal) {
    throw new Error(
      `amount mismatch: captured ${facts.amount}, payment ${payment.amount}, order ${payment.order.grandTotal}`,
    );
  }
  const currency = (facts.currency ?? payment.currency).toUpperCase();
  if (currency !== payment.currency.toUpperCase()) {
    throw new Error(`currency mismatch: ${currency} vs ${payment.currency}`);
  }
  if (!canTransitionPayment(payment.status, "PAID")) {
    // Already PAID (a re-delivery that beat the dedup, or an out-of-order event).
    return;
  }

  const paidAmount = facts.amount;
  const method = facts.method ?? "";
  const config = await getPaymentsConfig();

  const runTx = async (tx: Prisma.TransactionClient) => {
    const paidOrder = await tx.order.updateMany({
      where: { id: payment.order.id, status: "PENDING_PAYMENT" },
      data: {
        status: "PAID",
        paymentStatus: "PAID",
        paymentMethod: orderPaymentMethodFromProvider(method),
        updatedAt: new Date(),
      },
    });
    if (paidOrder.count === 0) return; // already advanced — idempotent no-op

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        method: method || null,
        paidAt: new Date(),
        lastEventId: eventId,
        // 9F-54 — persist the real PayMongo Payment id (pay_…). `providerId`
        // keeps the Checkout Session id (cs_…); this is the id a future provider
        // refund needs. Merged into the JSON metadata string so no schema change.
        metadata: mergeMetadata(payment.metadata, {
          providerPaymentId: facts.providerPaymentId ?? undefined,
        }),
      },
    });
    await tx.orderEvent.create({
      data: { orderId: payment.order.id, status: "PAID", title: "Payment received", detail: null },
    });

    if (!config.holdForReview) {
      const proc = await tx.order.updateMany({
        where: { id: payment.order.id, status: "PAID" },
        data: { status: "PROCESSING", updatedAt: new Date() },
      });
      if (proc.count === 1) {
        await tx.orderEvent.create({
          data: {
            orderId: payment.order.id,
            status: "PROCESSING",
            title: "Preparing your order",
            detail: null,
          },
        });
      }
    }
  };
  if (db === prisma) await prisma.$transaction(runTx);
  else await runTx(db as Prisma.TransactionClient);

  await writeAudit(
    {
      actorUserId: null,
      action: "payment.paid",
      targetType: "order",
      targetId: payment.order.id,
      summary: `PayMongo webhook: order ${payment.order.orderNumber} paid (${paidAmount} centavos, ${method || "unknown method"})`,
      meta: {
        eventId,
        providerId: payment.providerId,
        providerPaymentId: facts.providerPaymentId,
        amount: paidAmount,
        method,
        holdForReview: config.holdForReview,
      },
    },
    db === prisma ? undefined : (db as Prisma.TransactionClient),
  );

  if (db === prisma) {
    scheduleEmail(() => sendPaymentConfirmation(payment.order.id));
    if (!config.holdForReview) {
      const { sendOrderProcessing } = await import("@/lib/email/notifications");
      scheduleEmail(() => sendOrderProcessing(payment.order.id));
    }
  }
}

async function applyFailed(
  eventId: string,
  objId: string,
  attrs: Record<string, unknown>,
  db: Db,
): Promise<void> {
  const payment = await findPayment(objId, attrs, db);
  if (!payment) throw new Error(`no Payment for provider object ${objId}`);
  if (!canTransitionPayment(payment.status, "FAILED")) return;

  const reason = String(
    (attrs.last_payment_error as { message?: string } | undefined)?.message ??
      attrs.failed_message ??
      "declined",
  ).slice(0, 300);

  await db.payment.update({
    where: { id: payment.id },
    data: { status: "FAILED", failureReason: reason, lastEventId: eventId },
  });
  await db.orderEvent.create({
    data: {
      orderId: payment.order.id,
      status: payment.order.status,
      title: "Payment attempt failed",
      detail: null,
    },
  });
  await writeAudit(
    {
      actorUserId: null,
      action: "payment.failed",
      targetType: "order",
      targetId: payment.order.id,
      summary: `PayMongo webhook: payment failed for order ${payment.order.orderNumber}`,
      meta: { eventId, reason },
    },
    db === prisma ? undefined : (db as Prisma.TransactionClient),
  );
  // Order stays PENDING_PAYMENT — the customer can start a new session.
}

async function applyExpired(eventId: string, objId: string, db: Db): Promise<void> {
  const payment = await db.payment.findFirst({
    where: { providerId: objId },
    select: { id: true, status: true, orderId: true },
  });
  if (!payment || !canTransitionPayment(payment.status, "EXPIRED")) return;
  await db.payment.update({
    where: { id: payment.id },
    data: { status: "EXPIRED", lastEventId: eventId },
  });
  await writeAudit(
    {
      actorUserId: null,
      action: "payment.expired",
      targetType: "order",
      targetId: payment.orderId,
      summary: `PayMongo webhook: checkout session expired`,
      meta: { eventId },
    },
    db === prisma ? undefined : (db as Prisma.TransactionClient),
  );
}

async function applyRefundUpdate(
  eventId: string,
  objId: string,
  attrs: Record<string, unknown>,
  db: Db,
): Promise<void> {
  const refund = await db.paymentRefund.findFirst({
    where: { providerId: objId },
    include: {
      payment: { include: { order: { select: { id: true, orderNumber: true, grandTotal: true } } } },
      returnRequest: { select: { id: true, returnNumber: true } },
    },
  });
  if (!refund) throw new Error(`no PaymentRefund for ${objId}`);

  const providerStatus = String(attrs.status ?? "").toLowerCase();

  const txClient = db === prisma ? undefined : (db as Prisma.TransactionClient);

  if (providerStatus === "succeeded") {
    const runTx = async (tx: Prisma.TransactionClient) => {
      await tx.paymentRefund.updateMany({
        where: { id: refund.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "SUCCEEDED", succeededAt: new Date() },
      });

      // Sum all SUCCEEDED refunds for this payment.
      const agg = await tx.paymentRefund.aggregate({
        where: { paymentId: refund.paymentId, status: "SUCCEEDED" },
        _sum: { amount: true },
      });
      const refunded = agg._sum.amount ?? 0;
      const fully = refunded >= refund.payment.amount;

      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { status: fully ? "REFUNDED" : "PARTIALLY_REFUNDED", lastEventId: eventId },
      });
      await tx.order.updateMany({
        where: { id: refund.payment.order.id },
        data: { paymentStatus: fully ? "REFUNDED" : "PARTIALLY_REFUNDED", updatedAt: new Date() },
      });
      if (refund.returnRequest) {
        await tx.returnRequest.updateMany({
          where: { id: refund.returnRequest.id, status: "REFUND_INITIATED" },
          data: { status: "REFUND_COMPLETED", refundCompletedAt: new Date() },
        });
      }
    };
    if (db === prisma) await prisma.$transaction(runTx);
    else await runTx(db as Prisma.TransactionClient);

    await writeAudit(
      {
        actorUserId: null,
        action: "payment.refund_succeeded",
        targetType: "order",
        targetId: refund.payment.order.id,
        summary: `PayMongo webhook: refund ${objId} succeeded (${refund.amount} centavos) for order ${refund.payment.order.orderNumber}`,
        meta: { eventId, refundId: refund.id },
      },
      txClient,
    );
    if (db === prisma) scheduleEmail(() => sendRefundCompleted(refund.id));
  } else if (providerStatus === "failed") {
    await db.paymentRefund.updateMany({
      where: { id: refund.id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", failureReason: String(attrs.failure_reason ?? "refund failed").slice(0, 300) },
    });
    await writeAudit(
      {
        actorUserId: null,
        action: "payment.refund_failed",
        targetType: "order",
        targetId: refund.payment.order.id,
        summary: `PayMongo webhook: refund ${objId} FAILED for order ${refund.payment.order.orderNumber}`,
        meta: { eventId },
      },
      txClient,
    );
    // The ReturnRequest stays REFUND_INITIATED so an admin can retry / fall back.
  }
}

/** Guard against Prisma unique errors surfacing as 500s in the route. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
