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

const CONDITION_LABEL: Record<string, string> = {
  NEW: "New",
  REFURBISHED: "Refurbished",
  USED_LIKE_NEW: "Used — like new",
  USED_GOOD: "Used — good",
};

export function conditionLabel(condition: string) {
  return CONDITION_LABEL[condition] ?? condition;
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
