import {
  layout,
  heading,
  paragraph,
  button,
  infoBox,
  kvRow,
  itemsTable,
  addressBlock,
  peso,
  textBody,
  textFooter,
  reasonFor,
  esc,
} from "@/lib/email/html";
import { discountPercent } from "@/lib/utils";

/**
 * Order confirmation (Step 17 §6; Batch 3 Phase 2). Built ONLY from the
 * authoritative order snapshot — items/prices/discount/shipping come from the
 * OrderItem rows and the order's immutable coupon/shipping snapshots, never from
 * the browser or the current Product/Coupon/ShippingMethod records.
 *
 * The store's policy is pay on delivery — this email confirms the order was
 * received and never claims a payment has occurred.
 */

export type OrderConfirmationData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  placedAt: Date;
  customerName: string;
  items: {
    name: string;
    variantLabel: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    /**
     * 9F-38B: the frozen compare-at ("was") unit price at purchase time, from
     * `OrderItem.originalUnitPrice`. When present and greater than `unitPrice`
     * the row shows a "was ₱X" indicator + the derived discount %. NULL /
     * undefined / <= unitPrice → the row renders exactly as before. NEVER a
     * live-Offer read; never added to a total.
     */
    originalUnitPrice?: number | null;
  }[];
  subtotal: number;
  discountTotal: number;
  couponCode: string | null;
  shippingMethodName: string | null;
  shippingFee: number;
  grandTotal: number;
  shippingAddress: Record<string, unknown>;
  /** true for a pay-on-delivery order — a COD order that isn't paid online.
   *  Derived from the payment fields by the caller (9F-28B), NOT Order.status. */
  payOnDelivery: boolean;
  /** Store Pickup confirmation-email display (9F-49 email step). Optional so
   *  pre-existing callers (test fixtures, other tests) that don't know about
   *  pickup keep building byte-identical non-pickup output — undefined behaves
   *  exactly like false in every branch below. */
  pickup?: boolean;
  /** The frozen SellerOrder.pickupLocationSnapshot for this order (Phase-1:
   *  any one SellerOrder's snapshot, see notifications.ts ORDER_INCLUDE) —
   *  never the live PickupLocation row. Null/undefined for non-pickup orders,
   *  or unexpectedly for a pre-existing pickup order that predates this field. */
  pickupLocationSnapshot?: unknown;
};

/** Mirrors order-detail.tsx's PickupLocationSnapshot shape exactly. `recipient`
 *  exists in the stored snapshot but is deliberately never surfaced here — it's
 *  the store's own internal contact, not the customer-facing location name. */
type PickupLocationSnapshot = {
  name: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string;
  instructions: string | null;
};

function asPickupLocationSnapshot(v: unknown): PickupLocationSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.line1 !== "string") return null;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  return {
    name: o.name,
    line1: o.line1,
    line2: str("line2"),
    barangay: str("barangay"),
    city: str("city") ?? "",
    province: str("province") ?? "",
    postalCode: str("postalCode") ?? "",
    country: str("country") ?? "",
    phone: str("phone") ?? "",
    instructions: str("instructions"),
  };
}

// Same ink-soft tone addressBlock() uses, kept local since PALETTE isn't exported.
const INK_SOFT = "#5b564f";

/** HTML "Pickup at" block, built ONLY from the frozen snapshot — never the
 *  live PickupLocation row — so a later CMS edit never changes what an
 *  already-placed order's email shows. No internal id, no `recipient`. */
function pickupLocationBlockHtml(snapshot: PickupLocationSnapshot | null): string {
  if (!snapshot) {
    return `<p style="margin:0 0 18px;color:${INK_SOFT};font-size:13px;line-height:1.7;">Pickup location details unavailable.</p>`;
  }
  const lines = [
    snapshot.name,
    snapshot.line1,
    snapshot.line2,
    [snapshot.barangay, snapshot.city, snapshot.province, snapshot.postalCode].filter(Boolean).join(", "),
    snapshot.country,
    snapshot.phone,
  ].filter((p) => p && String(p).trim());
  const instructions = snapshot.instructions
    ? `<p style="margin:8px 0 18px;color:${INK_SOFT};font-size:13px;line-height:1.6;">${esc(snapshot.instructions)}</p>`
    : "";
  return (
    `<p style="margin:0 0 18px;color:${INK_SOFT};font-size:13px;line-height:1.7;">${lines.map((p) => esc(String(p))).join("<br>")}</p>` +
    instructions
  );
}

/** Plain-text "Pickup at:" lines — same field set as the HTML block. */
function pickupLocationLinesText(snapshot: PickupLocationSnapshot | null): string[] {
  if (!snapshot) return ["  Pickup location details unavailable."];
  const lines = [
    `  ${snapshot.name}`,
    `  ${[snapshot.line1, snapshot.line2].filter(Boolean).join(", ")}`,
    `  ${[snapshot.barangay, snapshot.city, snapshot.province, snapshot.postalCode].filter(Boolean).join(", ")}`,
    `  ${[snapshot.country, snapshot.phone].filter(Boolean).join(" · ")}`,
  ];
  return snapshot.instructions ? [...lines, ``, `  ${snapshot.instructions}`] : lines;
}

export function renderOrderConfirmation(d: OrderConfirmationData) {
  const subject = `Your ${d.brand} order is confirmed`;
  const reason = reasonFor("order", d.brand);
  const dateStr = d.placedAt.toISOString().slice(0, 10);

  const pickupSnapshot = d.pickup ? asPickupLocationSnapshot(d.pickupLocationSnapshot) : null;

  const paymentLine = d.payOnDelivery
    ? d.pickup
      ? "Your order has been received. Pay in cash when you collect your order."
      : "Your order has been received. Payment is arranged on delivery."
    : "Your order has been received.";

  const totalsRows =
    kvRow("Subtotal", peso(d.subtotal)) +
    (d.discountTotal > 0
      ? kvRow(`Discount${d.couponCode ? ` (${d.couponCode})` : ""}`, `-${peso(d.discountTotal)}`)
      : "") +
    kvRow(d.shippingMethodName ? `Shipping · ${d.shippingMethodName}` : "Shipping", d.shippingFee === 0 ? "Free" : peso(d.shippingFee)) +
    kvRow("Total", peso(d.grandTotal), { strong: true, last: true });

  const body = `
    ${heading("Your order is confirmed")}
    ${paragraph(`Hi ${d.customerName}, thanks for your order — it's confirmed and we're getting it ready. ${paymentLine}`)}
    ${button("View your order", d.orderUrl)}
    ${infoBox(kvRow("Order number", d.orderNumber) + kvRow("Order date", dateStr, { last: true }))}
    <h2 style="margin:22px 0 10px;font-size:15px;color:#2b2926;">Items</h2>
    ${itemsTable(d.items)}
    ${infoBox(totalsRows)}
    <h2 style="margin:22px 0 10px;font-size:15px;color:#2b2926;">${d.pickup ? "Pickup at" : "Shipping to"}</h2>
    ${d.pickup ? pickupLocationBlockHtml(pickupSnapshot) : addressBlock(d.shippingAddress)}
    ${paragraph("You can follow your order's progress any time from the link above.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} · placed ${dateStr}${d.payOnDelivery ? (d.pickup ? " · pay in cash when you collect your order" : " · pay on delivery") : ""}.`,
    reason,
  });

  const addr = d.shippingAddress;
  const text = textBody([
    `Your order is confirmed`,
    ``,
    `Hi ${d.customerName}, thanks for your order — it's confirmed and we're getting it ready.`,
    paymentLine,
    ``,
    `Order number: ${d.orderNumber}`,
    `Order date:   ${dateStr}`,
    ``,
    `Items:`,
    ...d.items.map((it) => {
      // 9F-38B: historical "was" line total + derived % from the frozen snapshot.
      const off =
        it.originalUnitPrice != null && it.originalUnitPrice > it.unitPrice
          ? discountPercent(it.unitPrice, it.originalUnitPrice)
          : 0;
      const wasNote =
        off > 0 ? `  (was ${peso(it.originalUnitPrice! * it.quantity)}, -${off}%)` : "";
      return `  - ${it.name}${it.variantLabel ? ` (${it.variantLabel})` : ""} x${it.quantity}  ${peso(it.lineTotal)}${wasNote}`;
    }),
    ``,
    `Subtotal:  ${peso(d.subtotal)}`,
    ...(d.discountTotal > 0 ? [`Discount:  -${peso(d.discountTotal)}${d.couponCode ? ` (${d.couponCode})` : ""}`] : []),
    `Shipping:  ${d.shippingFee === 0 ? "Free" : peso(d.shippingFee)}${d.shippingMethodName ? ` (${d.shippingMethodName})` : ""}`,
    `Total:     ${peso(d.grandTotal)}`,
    ``,
    ...(d.pickup
      ? [`Pickup at:`, ...pickupLocationLinesText(pickupSnapshot)]
      : [
          `Shipping to:`,
          `  ${[addr.firstName, addr.lastName].filter(Boolean).join(" ") || String(addr.recipient ?? "")}`,
          `  ${[addr.line1, addr.line2].filter(Boolean).join(", ")}`,
          `  ${[addr.barangay, addr.city, addr.province, addr.postalCode].filter(Boolean).join(", ")}`,
        ]),
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
