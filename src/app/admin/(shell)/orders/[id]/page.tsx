import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminOrder } from "@/lib/admin/orders";
import { orderReturnableLines } from "@/lib/admin/returns";
import { orderHasOpenReturn } from "@/lib/returns";
import { getOrderPayments, getPaymentsAdminConfig } from "@/lib/admin/payments";
import { PageHeader } from "@/components/admin/ui";
import { OrderDetailView } from "@/components/admin/orders/order-detail-view";
import { AdminStartReturn } from "@/components/admin/returns/admin-start-return";
import { PaymentPanel } from "@/components/admin/payments/payment-panel";
import {
  ORDER_STATUS_TRANSITIONS,
  isCancellable,
  isFulfillmentStatus,
  isOrderStatus,
} from "@/lib/orders/status";
import { isStorePickupCode } from "@/lib/orders/couriers";

export async function generateMetadata({
  params,
}: PageProps<"/admin/orders/[id]">): Promise<Metadata> {
  // Don't reveal the order number in the tab title to a viewer who can't see the
  // page (the body still enforces the real 403 below).
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("view_orders"))) {
    return { title: "Order" };
  }
  const { id } = await params;
  const order = await getAdminOrder(id);
  return { title: order ? `Order ${order.orderNumber}` : "Order" };
}

export default async function AdminOrderDetailPage({ params }: PageProps<"/admin/orders/[id]">) {
  const admin = await requirePermission("view_orders");
  const { id } = await params;

  const order = await getAdminOrder(id);
  if (!order) notFound();

  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_orders");
  // The generic "Move to" control only handles the pre-fulfilment step
  // (… → PROCESSING). Ship / out-for-delivery / deliver are the fulfilment panel.
  const forwardStatuses = (isOrderStatus(order.status) ? ORDER_STATUS_TRANSITIONS[order.status] : [])
    .filter((s) => !isFulfillmentStatus(s));
  const cancellable = isCancellable(order.status);
  const storePickup = isStorePickupCode(order.shippingMethodCode);
  // Pay-on-delivery "Confirm order": only for an unconfirmed order with no
  // online payment. The server action re-checks both.
  const canConfirm = canManage && order.status === "PENDING_PAYMENT" && !order.hasOnlinePayment;

  const canManageReturns = admin.isSuperAdmin || admin.permissions.has("manage_returns");
  const [returnable, openReturn] = canManageReturns
    ? await Promise.all([orderReturnableLines(order.id), orderHasOpenReturn(order.id)])
    : [null, null];

  const canViewPayments = admin.isSuperAdmin || admin.permissions.has("view_payments");
  const canManagePayments = admin.isSuperAdmin || admin.permissions.has("manage_payments");
  const [orderPayments, paymentsConfig] = canViewPayments
    ? await Promise.all([getOrderPayments(order.id), getPaymentsAdminConfig()])
    : [null, null];

  return (
    <div>
      <Link
        href="/admin/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All orders
      </Link>

      <PageHeader
        title={`Order ${order.orderNumber}`}
        description={`Placed by ${order.customerName} · ${order.user?.email ?? order.email}`}
      />

      <OrderDetailView
        order={order}
        forwardStatuses={forwardStatuses}
        cancellable={cancellable}
        canManage={canManage}
        canConfirm={canConfirm}
        storePickup={storePickup}
      />

      {canViewPayments && orderPayments && (
        <div className="mt-6">
          <PaymentPanel
            payments={orderPayments}
            canManage={canManagePayments}
            onlinePaymentEnabled={paymentsConfig?.onlinePaymentEnabled ?? false}
          />
        </div>
      )}

      {canManageReturns && returnable && (
        <div className="mt-6">
          <AdminStartReturn
            orderId={order.id}
            orderNumber={order.orderNumber}
            orderStatus={order.status}
            openReturnNumber={openReturn?.open ? (openReturn.returnNumber ?? null) : null}
            lines={returnable.lines
              .filter((l) => l.remaining > 0)
              .map((l) => ({
                orderItemId: l.orderItemId,
                name: l.name,
                variantLabel: l.variantLabel,
                remaining: l.remaining,
              }))}
          />
        </div>
      )}
    </div>
  );
}
