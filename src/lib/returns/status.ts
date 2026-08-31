/**
 * Returns / RMA state machine (Step 21 P3). Pure data + pure functions — safe to
 * import from server, client and edge code. Mirrors the shape of
 * `src/lib/orders/status.ts`.
 *
 * State flow:
 *   REQUESTED → APPROVED → RECEIVED → REFUND_INITIATED → REFUND_COMPLETED
 *   REQUESTED → REJECTED                                              (terminal)
 *   REQUESTED | APPROVED | RECEIVED | REFUND_INITIATED → CANCELLED    (terminal)
 *
 * No backward transitions, no skipped states. The refund steps are BOOKKEEPING
 * ONLY — PayMongo is deferred, no money moves, Order.paymentStatus is untouched.
 */

export const RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "RECEIVED",
  "REFUND_INITIATED",
  "REFUND_COMPLETED",
  "CANCELLED",
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export function isReturnStatus(value: string): value is ReturnStatus {
  return (RETURN_STATUSES as readonly string[]).includes(value);
}

/** Terminal states — no further transition is possible. */
export const TERMINAL_RETURN_STATUSES: ReturnStatus[] = [
  "REJECTED",
  "REFUND_COMPLETED",
  "CANCELLED",
];

export function isTerminalReturnStatus(status: string): boolean {
  return (TERMINAL_RETURN_STATUSES as string[]).includes(status);
}

/**
 * The "open" set that the partial unique index
 * (`return_one_open_per_order`) treats as blocking a second return for an order.
 * Anything NOT in {REJECTED, CANCELLED, REFUND_COMPLETED}.
 */
export function isOpenReturnStatus(status: string): boolean {
  return isReturnStatus(status) && !isTerminalReturnStatus(status);
}

/** Every valid forward / terminal transition, keyed by the current status. */
export const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["RECEIVED", "CANCELLED"],
  REJECTED: [],
  RECEIVED: ["REFUND_INITIATED", "CANCELLED"],
  REFUND_INITIATED: ["REFUND_COMPLETED", "CANCELLED"],
  REFUND_COMPLETED: [],
  CANCELLED: [],
};

/** Server-side guard for a return status change. */
export function canTransitionReturn(from: string, to: string): boolean {
  if (!isReturnStatus(from) || !isReturnStatus(to)) return false;
  return RETURN_TRANSITIONS[from].includes(to);
}

/** Who may cancel a return from a given state. */
export function customerCanCancel(status: string): boolean {
  return status === "REQUESTED";
}
export function adminCanCancel(status: string): boolean {
  return isReturnStatus(status) && RETURN_TRANSITIONS[status].includes("CANCELLED");
}

// ---------------------------------------------------------------------------
// Labels & tones (display only)
// ---------------------------------------------------------------------------

export const RETURN_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  RECEIVED: "Received",
  REFUND_INITIATED: "Refund initiated",
  REFUND_COMPLETED: "Refund completed",
  CANCELLED: "Cancelled",
};

export function returnStatusLabel(status: string): string {
  return RETURN_STATUS_LABEL[status] ?? status;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function returnStatusTone(status: string): BadgeTone {
  switch (status) {
    case "REQUESTED":
      return "warning";
    case "APPROVED":
    case "RECEIVED":
    case "REFUND_INITIATED":
      return "info";
    case "REFUND_COMPLETED":
      return "success";
    case "REJECTED":
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Reason codes (customer-selected, whole request)
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "NOT_AS_DESCRIBED",
  "NO_LONGER_NEEDED",
  "OTHER",
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Field limits shared by the customer form and the server action. */
export const RETURN_LIMITS = {
  noteMax: 2000,
  staffNoteMax: 2000,
  resolutionNoteMax: 2000,
} as const;

export function isReturnReason(value: string): value is ReturnReason {
  return (RETURN_REASONS as readonly string[]).includes(value);
}

export const RETURN_REASON_LABEL: Record<string, string> = {
  DAMAGED: "Arrived damaged or faulty",
  WRONG_ITEM: "Wrong item received",
  NOT_AS_DESCRIBED: "Not as described",
  NO_LONGER_NEEDED: "No longer needed",
  OTHER: "Other",
};

export function returnReasonLabel(reason: string): string {
  return RETURN_REASON_LABEL[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Item condition at receipt (admin-set)
// ---------------------------------------------------------------------------

export const RETURN_ITEM_CONDITIONS = ["RESELLABLE", "OPENED", "DAMAGED"] as const;
export type ReturnItemCondition = (typeof RETURN_ITEM_CONDITIONS)[number];

export function isReturnItemCondition(value: string): value is ReturnItemCondition {
  return (RETURN_ITEM_CONDITIONS as readonly string[]).includes(value);
}

export const RETURN_ITEM_CONDITION_LABEL: Record<string, string> = {
  RESELLABLE: "Resellable",
  OPENED: "Opened",
  DAMAGED: "Damaged",
};
