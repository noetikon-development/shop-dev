import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Partial (single-seller) cancellation notification (9F-60). Distinct from
 * `renderOrderCancelled`, which claims the WHOLE order was cancelled — this
 * fires when one seller's items were cancelled but the rest of the order
 * (at least one other seller) remains active, so the parent Order itself was
 * never touched.
 *
 * `refundAmount` is `null` whenever no PaymentRefund exists for this
 * cancellation (COD, no eligible Payment, or the provider-refund feature
 * being off — the only case in Production today) — the copy never claims a
 * refund that wasn't actually created.
 */

export type OrderPartiallyCancelledData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  sellerName: string;
  itemCount: number;
  reason: string | null;
  refundAmount: number | null; // centavos; null = no refund record exists
};

export function renderOrderPartiallyCancelled(d: OrderPartiallyCancelledData) {
  const subject = `Part of your ${d.brand} order (${d.orderNumber}) was cancelled`;
  const reasonLine = reasonFor("order", d.brand);
  const itemWord = d.itemCount === 1 ? "item" : "items";

  const rows =
    kvRow("Order number", d.orderNumber) +
    kvRow("Affected seller", d.sellerName) +
    kvRow("Items cancelled", `${d.itemCount} ${itemWord}`, { last: !d.reason && d.refundAmount == null }) +
    (d.reason ? kvRow("Reason", d.reason, { last: d.refundAmount == null }) : "") +
    (d.refundAmount != null ? kvRow("Refund amount", peso(d.refundAmount), { last: true }) : "");

  const refundParagraph =
    d.refundAmount != null
      ? `A refund of ${peso(d.refundAmount)} for these items will be issued to your original payment method.`
      : `You will not be charged for these items.`;

  const body = `
    ${heading("Part of your order was cancelled")}
    ${paragraph(`Hi ${d.customerName}, ${d.sellerName} cancelled ${d.itemCount} ${itemWord} from your order ${d.orderNumber}. The rest of your order is unaffected and will continue as normal.`)}
    ${infoBox(rows)}
    ${paragraph(refundParagraph)}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `${d.sellerName} cancelled ${d.itemCount} ${itemWord} from order ${d.orderNumber}.`,
    reason: reasonLine,
  });

  const text = textBody([
    `Part of your order was cancelled`,
    ``,
    `Hi ${d.customerName}, ${d.sellerName} cancelled ${d.itemCount} ${itemWord} from your order ${d.orderNumber}.`,
    `The rest of your order is unaffected and will continue as normal.`,
    ``,
    `Order number:     ${d.orderNumber}`,
    `Affected seller:  ${d.sellerName}`,
    `Items cancelled:  ${d.itemCount} ${itemWord}`,
    ...(d.reason ? [`Reason:           ${d.reason}`] : []),
    ...(d.refundAmount != null ? [`Refund amount:    ${peso(d.refundAmount)}`] : []),
    ``,
    refundParagraph,
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reasonLine),
  ]);

  return { subject, html, text };
}
