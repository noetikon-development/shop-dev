import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Payment confirmation (Step 21 P4). DORMANT — fired ONLY by a
 * signature-verified PayMongo payment webhook. Online payment is disabled, so no
 * Payment row can exist and this never sends. Restyled to the Axiaro master
 * design so it is ready when PayMongo is enabled; it is not activated here.
 *
 * No card number, no token, no provider secret. The only reference shown is the
 * store's own order number.
 */

export type PaymentConfirmationData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  amount: number; // centavos
  methodLabel: string; // "card" | "GCash" | "your payment method"
  paidAt: Date;
};

export function renderPaymentConfirmation(d: PaymentConfirmationData) {
  const subject = `Your ${d.brand} payment is confirmed`;
  const reason = reasonFor("order", d.brand);
  const when = d.paidAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const body = `
    ${heading("Payment received")}
    ${paragraph(`Hi ${d.customerName}, we've received your payment for order ${d.orderNumber}. Your order is now being prepared and we'll email you again when it ships.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) +
        kvRow("Amount paid", peso(d.amount)) +
        kvRow("Paid with", d.methodLabel) +
        kvRow("When", when, { last: true }),
    )}
    ${button("View your order", d.orderUrl)}
    ${paragraph("This is a confirmation of payment, not a receipt for tax purposes.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Payment received for order ${d.orderNumber}.`,
    reason,
  });

  const text = textBody([
    `Payment received`,
    ``,
    `Hi ${d.customerName}, we've received your payment for order ${d.orderNumber}.`,
    `Your order is now being prepared and we'll email you again when it ships.`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Amount paid:  ${peso(d.amount)}`,
    `Paid with:    ${d.methodLabel}`,
    `When:         ${when}`,
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
