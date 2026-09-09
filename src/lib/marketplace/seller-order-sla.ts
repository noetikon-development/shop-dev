/**
 * 3P seller-order acceptance SLA (Phase 9F-32A) — PURE config + helpers.
 *
 * A THIRD_PARTY COD order is auto-confirmed to `Order.status = PROCESSING` at
 * checkout (9F-15B) while its `SellerOrder.status` stays `PENDING_PAYMENT` until
 * the seller clicks "Accept order". Nothing chases the seller if they don't.
 * This defines when to nudge the seller and when to escalate to Axiaro Ops.
 *
 * Both thresholds live HERE as named constants — change them in one place. They
 * are expressed in milliseconds so the job can compare against a `Date` diff
 * directly. No environment variable, no scattered literals.
 *
 * Deliberately only TWO stages (reminder, overdue) — no extra escalation levels.
 */

export const SELLER_ORDER_ACCEPTANCE_SLA = {
  /** Nudge the seller once the SellerOrder has been PENDING_PAYMENT this long. */
  reminderAfterMs: 4 * 60 * 60 * 1000, // 4 hours
  /** Escalate to Axiaro Ops (audit + email) once it has been this long. */
  escalateAfterMs: 24 * 60 * 60 * 1000, // 24 hours
} as const;

export type AcceptanceSlaStage = "none" | "reminder" | "overdue";

/** Milliseconds a SellerOrder has been awaiting acceptance (never negative). */
export function acceptanceAgeMs(pendingSince: Date, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - pendingSince.getTime());
}

/** Which SLA stage an age has reached. `overdue` implies `reminder` is also due. */
export function acceptanceSlaStage(ageMs: number): AcceptanceSlaStage {
  if (ageMs >= SELLER_ORDER_ACCEPTANCE_SLA.escalateAfterMs) return "overdue";
  if (ageMs >= SELLER_ORDER_ACCEPTANCE_SLA.reminderAfterMs) return "reminder";
  return "none";
}

/**
 * Compact human phrase for how long an order has waited — used in the emails
 * and the audit summary. Rounds DOWN to whole hours (or days + hours past 24h)
 * so it never overstates the wait.
 *   3_600_000        → "1 hour"
 *   16_200_000       → "4 hours"
 *   past 24h         → "1 day 6 hours" / "2 days"
 */
export function humanizeWait(ms: number): string {
  const totalHours = Math.floor(ms / (60 * 60 * 1000));
  if (totalHours < 1) return "less than an hour";
  if (totalHours < 24) return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const dayPart = `${days} day${days === 1 ? "" : "s"}`;
  return hours === 0 ? dayPart : `${dayPart} ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Human label for a threshold, for the Ops email / audit ("24 hours"). */
export function thresholdLabel(ms: number): string {
  return humanizeWait(ms);
}
