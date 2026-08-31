import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminReturn } from "@/lib/admin/returns";
import { Card, PageHeader, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  returnStatusLabel,
  returnStatusTone,
  returnReasonLabel,
  RETURN_ITEM_CONDITION_LABEL,
} from "@/lib/returns/status";
import { ReturnAdminPanel } from "@/components/admin/returns/return-admin-panel";

export async function generateMetadata({
  params,
}: PageProps<"/admin/returns/[id]">): Promise<Metadata> {
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("manage_returns"))) {
    return { title: "Return" };
  }
  const { id } = await params;
  const ret = await getAdminReturn(id);
  return { title: ret ? `Return ${ret.returnNumber}` : "Return" };
}

function dt(iso: string | null) {
  return iso ? formatDate(iso, { hour: "numeric", minute: "2-digit" }) : "—";
}

export default async function AdminReturnDetailPage({ params }: PageProps<"/admin/returns/[id]">) {
  await requirePermission("manage_returns");
  const { id } = await params;
  const ret = await getAdminReturn(id);
  if (!ret) notFound();

  const overridden: string[] = ret.overriddenRules ? safeArray(ret.overriddenRules) : [];
  const itemRefundSum = ret.items.reduce((n, i) => n + i.refundAmount, 0);
  const showReceiptColumns = ["RECEIVED", "REFUND_INITIATED", "REFUND_COMPLETED"].includes(ret.status);

  return (
    <div>
      <Link
        href="/admin/returns"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All returns
      </Link>

      <PageHeader
        title={`Return ${ret.returnNumber}`}
        description={`For order ${ret.order.orderNumber} · ${ret.user?.email ?? ret.order.email}`}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <h2 className="text-sm font-semibold text-ink">Request</h2>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Status">
                <StatusBadge tone={returnStatusTone(ret.status)}>
                  {returnStatusLabel(ret.status)}
                </StatusBadge>
              </Field>
              <Field label="Requested">{dt(ret.createdAt)}</Field>
              <Field label="Updated">{dt(ret.updatedAt)}</Field>
              <Field label="Reason">{returnReasonLabel(ret.reason)}</Field>
              <Field label="Raised by">{ret.adminAssisted ? "Admin (assisted)" : "Customer"}</Field>
              <Field label="Order">
                <Link href={`/admin/orders/${ret.order.id}`} className="font-mono hover:underline">
                  {ret.order.orderNumber}
                </Link>
              </Field>
            </dl>
            {overridden.length > 0 && (
              <p className="mt-4 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
                Assisted return — overrode eligibility: {overridden.join(", ")}.
              </p>
            )}
            {ret.customerNote && (
              <p className="mt-4 whitespace-pre-wrap rounded-sm bg-surface-sunken px-3 py-2 text-sm text-ink-soft">
                <span className="font-medium text-ink">Customer note:</span> {ret.customerNote}
              </p>
            )}
            {ret.resolutionNote && (
              <p className="mt-3 whitespace-pre-wrap rounded-sm bg-surface-sunken px-3 py-2 text-sm text-ink-soft">
                <span className="font-medium text-ink">Note to customer:</span> {ret.resolutionNote}
              </p>
            )}
          </Card>

          <Card padded={false}>
            <h2 className="px-5 pt-5 text-sm font-semibold text-ink">
              Return items ({ret.items.length})
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-y border-line bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-5 py-2.5 font-semibold">Product</th>
                    <th className="px-4 py-2.5 font-semibold">SKU</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Qty</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Line refund</th>
                    {showReceiptColumns && (
                      <>
                        <th className="px-4 py-2.5 text-right font-semibold">Restocked</th>
                        <th className="px-5 py-2.5 font-semibold">Condition</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {ret.items.map((it) => (
                    <tr key={it.id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3">
                        <span className="font-medium text-ink">{it.name}</span>
                        {it.variantLabel && (
                          <p className="text-xs text-ink-faint">{it.variantLabel}</p>
                        )}
                        {!it.variantHasInventory && it.variantId && (
                          <p className="text-xs text-clay">No inventory record — restock will be skipped.</p>
                        )}
                        {!it.variantId && (
                          <p className="text-xs text-ink-faint">No variant — not stock-tracked.</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs text-ink-soft">{it.sku ?? "—"}</code>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{it.quantity}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatPrice(it.refundAmount)}</td>
                      {showReceiptColumns && (
                        <>
                          <td className="px-4 py-3 text-right tabular-nums">{it.restockQuantity}</td>
                          <td className="px-5 py-3 text-ink-soft">
                            {it.condition ? RETURN_ITEM_CONDITION_LABEL[it.condition] ?? it.condition : "—"}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-5 pb-4 pt-3 text-xs text-ink-faint">
              Names, SKUs and prices are the immutable snapshot taken from the order when the return
              was opened.
            </p>
          </Card>

          {ret.staffNote && (
            <Card>
              <h2 className="text-sm font-semibold text-ink">Internal notes</h2>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-soft">
                {ret.staffNote}
              </pre>
              <p className="mt-2 text-xs text-ink-faint">Internal only — never shown to the customer or emailed.</p>
            </Card>
          )}
        </div>

        <aside className="space-y-6">
          <ReturnAdminPanel
            returnId={ret.id}
            status={ret.status}
            items={ret.items.map((i) => ({
              id: i.id,
              name: i.name,
              quantity: i.quantity,
              variantHasInventory: i.variantHasInventory,
              hasVariant: Boolean(i.variantId),
            }))}
            itemRefundSum={itemRefundSum}
            orderGrandTotal={ret.order.grandTotal}
            orderPaymentMethod={ret.order.paymentMethod}
            existingRefundAmount={ret.refundAmount}
            existingRefundMethod={ret.refundMethod}
          />

          <Card>
            <h2 className="text-sm font-semibold text-ink">Refund</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Bookkeeping only. Recording a refund here does not move money — process the actual
              refund in your payment provider or bank. <code>Order.paymentStatus</code> is not
              changed by returns.
            </p>
            <dl className="mt-3 space-y-2 text-sm">
              <Field label="Amount recorded">
                {ret.refundAmount != null ? formatPrice(ret.refundAmount) : "—"}
              </Field>
              <Field label="Method">{ret.refundMethod ?? "—"}</Field>
              <Field label="Reference">{ret.refundReference ?? "—"}</Field>
              <Field label="Initiated">{dt(ret.refundInitiatedAt)}</Field>
              <Field label="Completed">{dt(ret.refundCompletedAt)}</Field>
            </dl>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-ink">Order</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Field label="Order total">{formatPrice(ret.order.grandTotal)}</Field>
              <Field label="Payment">
                {ret.order.paymentMethod} · {ret.order.paymentStatus}
              </Field>
              <Field label="Order status">{ret.order.status}</Field>
              <Field label="Delivered">{dt(ret.order.deliveredAt)}</Field>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
