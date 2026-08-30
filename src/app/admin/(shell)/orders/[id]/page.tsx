import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminOrder } from "@/lib/admin/orders";
import { PageHeader } from "@/components/admin/ui";
import { OrderDetailView } from "@/components/admin/orders/order-detail-view";
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
        storePickup={storePickup}
      />
    </div>
  );
}
