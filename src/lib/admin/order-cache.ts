import "server-only";
import { revalidatePath } from "next/cache";

/**
 * Revalidate every page that renders a given order after an admin mutation:
 * the admin list + detail, the dashboard, the customer's account order pages,
 * the confirmation page and the public tracking page.
 */
export function revalidateOrderPaths(orderNumber: string, orderId: string) {
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin");
  revalidatePath("/account/orders");
  revalidatePath(`/account/orders/${orderNumber}`);
  revalidatePath(`/order/${orderNumber}`);
  revalidatePath("/track");
}
