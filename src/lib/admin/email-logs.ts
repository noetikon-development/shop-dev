import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Admin read layer for the transactional-email delivery log (Step 17 §18/§21).
 * Uncached. Metadata only — email bodies are never stored or shown.
 */

export const EMAIL_LOG_PAGE_SIZE = 25;

export const EMAIL_TYPES = [
  "order_confirmation",
  "order_processing",
  "order_shipped",
  "out_for_delivery",
  "order_delivered",
  "order_cancelled",
  "welcome",
  "password_changed",
  "email_changed",
  "sign_in_alert",
  "refund_notification",
  "email_verification",
  "password_reset",
] as const;

export const EMAIL_STATUSES = ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED"] as const;

export type EmailLogFilters = {
  q?: string;
  type?: string;
  status?: string;
  page?: number;
};

export type EmailLogRow = {
  id: string;
  type: string;
  recipient: string;
  subject: string;
  status: string;
  provider: string | null;
  error: string | null;
  attempts: number;
  orderNumber: string | null;
  orderId: string | null;
  createdAt: string;
  sentAt: string | null;
};

/** Mask an email address for display: j***@example.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const shown = local.slice(0, 1);
  return `${shown}${"*".repeat(Math.max(1, Math.min(local.length - 1, 3)))}@${domain}`;
}

export async function listEmailLogs(filters: EmailLogFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.EmailLogWhereInput = {};

  if (filters.type && (EMAIL_TYPES as readonly string[]).includes(filters.type)) {
    where.type = filters.type;
  }
  if (filters.status && (EMAIL_STATUSES as readonly string[]).includes(filters.status)) {
    where.status = filters.status;
  }
  if (filters.q?.trim()) {
    const q = filters.q.trim();
    where.OR = [
      { recipient: { contains: q, mode: "insensitive" } },
      { subject: { contains: q, mode: "insensitive" } },
      { order: { orderNumber: { contains: q, mode: "insensitive" } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * EMAIL_LOG_PAGE_SIZE,
      take: EMAIL_LOG_PAGE_SIZE,
      select: {
        id: true,
        type: true,
        recipient: true,
        subject: true,
        status: true,
        provider: true,
        error: true,
        attempts: true,
        orderId: true,
        createdAt: true,
        sentAt: true,
        order: { select: { orderNumber: true } },
      },
    }),
    prisma.emailLog.count({ where }),
  ]);

  const mapped: EmailLogRow[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    recipient: r.recipient,
    subject: r.subject,
    status: r.status,
    provider: r.provider,
    error: r.error,
    attempts: r.attempts,
    orderNumber: r.order?.orderNumber ?? null,
    orderId: r.orderId,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
  }));

  return { rows: mapped, total, page, pageCount: Math.max(1, Math.ceil(total / EMAIL_LOG_PAGE_SIZE)) };
}

export async function getEmailLogCounts(): Promise<Record<string, number>> {
  const groups = await prisma.emailLog.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { ALL: 0, PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };
  for (const g of groups) {
    out[g.status] = g._count._all;
    out.ALL += g._count._all;
  }
  return out;
}
