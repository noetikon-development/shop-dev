import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * Payment confirmation (Step 21 P4). Fired ONLY by a signature-verified PayMongo
 * payment webhook — never because an order exists. Confirms money captured and
 * that the order is now being prepared.
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
  const subject = `Payment received for order ${d.orderNumber} — ${d.brand}`;
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
    previewText: `Payment received for order ${d.orderNumber}`,
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
  ]);

  return { subject, html, text };
}
