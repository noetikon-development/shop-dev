"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RefreshCw, Loader2 } from "lucide-react";
import { DataTable, type Column, StatusBadge, notify } from "@/components/admin/ui";
import { formatDate } from "@/lib/utils";
import { retryEmailLogAction } from "@/lib/admin/email-log-actions";
import type { EmailLogRow } from "@/lib/admin/email-logs";

const TYPE_LABEL: Record<string, string> = {
  order_confirmation: "Order confirmation",
  order_processing: "Preparing order",
  order_shipped: "Shipment",
  out_for_delivery: "Out for delivery",
  order_delivered: "Delivery",
  order_cancelled: "Cancellation",
  welcome: "Welcome",
  refund_notification: "Refund",
  email_verification: "Email verification",
  password_reset: "Password reset",
};

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  PENDING: "warning",
  SENDING: "info",
  SENT: "success",
  FAILED: "danger",
  SKIPPED: "neutral",
};

function RetryButton({ id, status, canRetry }: { id: string; status: string; canRetry: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!canRetry || (status !== "FAILED" && status !== "SKIPPED")) return null;

  return (
    <button
      type="button"
      onClick={() =>
        start(async () => {
          const res = await retryEmailLogAction({ id });
          if (res.ok) notify.success(res.message ?? "Done");
          else notify.error(res.error ?? "That didn't work.");
          router.refresh();
        })
      }
      disabled={pending}
      className="btn btn-ghost p-1.5 text-ink-faint"
      title="Retry"
      aria-label="Retry email"
    >
      {pending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
    </button>
  );
}

export function EmailLogsTable({
  rows,
  canRetry,
  searching,
}: {
  rows: EmailLogRow[];
  canRetry: boolean;
  searching: boolean;
}) {
  const columns: Column<EmailLogRow>[] = [
    {
      key: "email",
      header: "Email",
      cell: (r) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{TYPE_LABEL[r.type] ?? r.type}</p>
          <p className="truncate text-xs text-ink-faint">{r.subject}</p>
        </div>
      ),
    },
    {
      key: "recipient",
      header: "Recipient",
      cell: (r) => <span className="text-ink-soft">{r.recipient}</span>,
    },
    {
      key: "order",
      header: "Order",
      cell: (r) =>
        r.orderId ? (
          <Link href={`/admin/orders/${r.orderId}`} className="font-mono text-xs text-ink-soft hover:underline">
            {r.orderNumber}
          </Link>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <div>
          <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
          {r.error && r.status === "FAILED" && (
            <p className="mt-1 max-w-[16rem] truncate text-xs text-clay" title={r.error}>
              {r.error}
            </p>
          )}
          {r.status === "SKIPPED" && (
            <p className="mt-1 text-xs text-ink-faint">no provider configured</p>
          )}
        </div>
      ),
    },
    {
      key: "created",
      header: "Created",
      cell: (r) => <span className="whitespace-nowrap text-ink-faint">{formatDate(r.createdAt, { hour: "numeric", minute: "2-digit" })}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => <RetryButton id={r.id} status={r.status} canRetry={canRetry} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <Mail size={18} />,
        title: searching ? "No emails match your filter." : "No transactional emails yet.",
        description: searching
          ? "Try a different type, status or search."
          : "Order confirmations, shipment and delivery notices will appear here.",
      }}
    />
  );
}
