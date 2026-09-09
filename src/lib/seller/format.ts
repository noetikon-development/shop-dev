/** Pure formatting helpers for the seller portal. Safe to import anywhere. */

const OFFER_STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  INACTIVE: "warning",
  ARCHIVED: "danger",
};

export function offerStatusTone(status: string) {
  return OFFER_STATUS_TONE[status] ?? "neutral";
}

// 9F-36B: the condition vocabulary + labels now live in the single canonical
// module `@/lib/marketplace/conditions`. Re-exported here so the ~15 existing
// `conditionLabel` import sites don't have to change.
export { conditionLabel } from "@/lib/marketplace/conditions";

/** True for a real, non-"New" condition — the gate for showing a condition line/chip. */
export function isNoteworthyCondition(condition: string | null | undefined): boolean {
  return Boolean(condition) && condition !== "NEW";
}

export function pesos(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

const CONTENT_STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  PENDING: "info",
  APPROVED: "success",
};

export function contentStatusTone(status: string) {
  return CONTENT_STATUS_TONE[status] ?? "neutral";
}

const CONTENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "In review",
  APPROVED: "Approved",
};

export function contentStatusLabel(status: string) {
  return CONTENT_STATUS_LABEL[status] ?? status;
}

const REQUEST_STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  PENDING: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

export function requestStatusTone(status: string) {
  return REQUEST_STATUS_TONE[status] ?? "neutral";
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "In review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function requestStatusLabel(status: string) {
  return REQUEST_STATUS_LABEL[status] ?? status;
}
