import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendSellerOrderAcceptanceReminder,
  sendSellerOrderAcceptanceOverdueOps,
} from "@/lib/email/notifications";
import {
  SELLER_ORDER_ACCEPTANCE_SLA,
  acceptanceAgeMs,
  acceptanceSlaStage,
  humanizeWait,
  thresholdLabel,
} from "@/lib/marketplace/seller-order-sla";

/**
 * 3P seller-order acceptance SLA sweep (Phase 9F-32A).
 *
 * Finds every THIRD_PARTY `SellerOrder` still `PENDING_PAYMENT` on a parent
 * `Order` that is `PROCESSING` (i.e. confirmed, fulfillable, and the seller CAN
 * and SHOULD accept it) and:
 *   - >= 4h waiting  → one seller reminder email (`SELLER_ORDER_ACCEPTANCE_REMINDER:<id>`)
 *   - >= 24h waiting → one `seller_order.acceptance_overdue` audit row + one Ops
 *                       escalation email (`SELLER_ORDER_ACCEPTANCE_OVERDUE:<id>`)
 *
 * Idempotent: the `EmailLog` UNIQUE key dedupes the emails, and the audit is
 * guarded by an existence check, so re-running the sweep never double-notifies.
 * The query itself is the primary state re-check (it re-reads current status);
 * each email sender re-reads the row again and SKIPs if the seller has since
 * accepted / declined. FIRST_PARTY rows and CANCELLED / SHIPPED / DELIVERED
 * orders are excluded by the `where` clause and never reach a notification.
 *
 * Never writes to any order / SellerOrder / inventory row — read + notify only.
 */

const OVERDUE_AUDIT_ACTION = "seller_order.acceptance_overdue";

export type SellerOrderSlaJobResult = {
  scanned: number;
  /** SellerOrder ids a reminder was (re-)scheduled for this run. */
  reminded: string[];
  /** SellerOrder ids an escalation (audit + Ops email) was raised for this run. */
  escalated: string[];
  /** Candidates still below the reminder threshold. */
  waiting: number;
};

export async function runSellerOrderAcceptanceSla(opts?: {
  now?: Date;
  client?: Prisma.TransactionClient;
  /** Test hook — defaults to `scheduleEmail` (fire-and-forget after the response). */
  dispatch?: (run: () => Promise<unknown>) => void;
}): Promise<SellerOrderSlaJobResult> {
  const db = opts?.client ?? prisma;
  const now = opts?.now ?? new Date();
  const fire = opts?.dispatch ?? scheduleEmail;

  const candidates = await db.sellerOrder.findMany({
    where: {
      sellerType: "THIRD_PARTY",
      status: "PENDING_PAYMENT",
      order: { is: { status: "PROCESSING" } },
    },
    select: {
      id: true,
      sellerId: true,
      createdAt: true,
      order: { select: { orderNumber: true } },
    },
  });

  const result: SellerOrderSlaJobResult = {
    scanned: candidates.length,
    reminded: [],
    escalated: [],
    waiting: 0,
  };

  for (const so of candidates) {
    const ageMs = acceptanceAgeMs(so.createdAt, now);
    const stage = acceptanceSlaStage(ageMs);
    if (stage === "none") {
      result.waiting += 1;
      continue;
    }

    // --- reminder (>= 4h) — fire once, keyed on the SellerOrder id ------------
    const reminderKey = `SELLER_ORDER_ACCEPTANCE_REMINDER:${so.id}`;
    const alreadyReminded = (await db.emailLog.count({ where: { idempotencyKey: reminderKey } })) > 0;
    if (!alreadyReminded) {
      result.reminded.push(so.id);
      fire(() => sendSellerOrderAcceptanceReminder(so.id, { client: opts?.client, now }));
    }

    // --- escalation (>= 24h) — audit row (once) + Ops email (once) -----------
    if (stage === "overdue") {
      const alreadyEscalated =
        (await db.adminAuditLog.count({
          where: { action: OVERDUE_AUDIT_ACTION, targetType: "seller_order", targetId: so.id },
        })) > 0;
      if (!alreadyEscalated) {
        await writeAudit(
          {
            actorUserId: null,
            action: OVERDUE_AUDIT_ACTION,
            targetType: "seller_order",
            targetId: so.id,
            summary:
              `Seller order ${so.id} for order ${so.order.orderNumber} has been PENDING_PAYMENT ` +
              `(unaccepted) for ${humanizeWait(ageMs)} — past the ${thresholdLabel(SELLER_ORDER_ACCEPTANCE_SLA.escalateAfterMs)} escalation threshold`,
            meta: {
              sellerOrderId: so.id,
              sellerId: so.sellerId,
              orderNumber: so.order.orderNumber,
              sellerOrderStatus: "PENDING_PAYMENT",
              waitedMs: ageMs,
              waitedLabel: humanizeWait(ageMs),
              escalationThresholdMs: SELLER_ORDER_ACCEPTANCE_SLA.escalateAfterMs,
            },
          },
          opts?.client,
        );
        result.escalated.push(so.id);
        fire(() => sendSellerOrderAcceptanceOverdueOps(so.id, { client: opts?.client, now }));
      }
    }
  }

  return result;
}
