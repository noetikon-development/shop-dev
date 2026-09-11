import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Payment session expired or cancelled (9F-55). Fired ONLY by a
 * signature-verified PayMongo `checkout_session.expired` webhook — never from a
 * browser redirect. PayMongo does not emit a separate "cancelled" event for the
 * event types this integration handles; a customer closing the hosted checkout
 * page without paying also surfaces here once the session times out, which is
 * why one email covers both "expired" and "cancelled" in its name.
 *
 * The order itself is untouched (still PENDING_PAYMENT / NONE), so — same as a
 * failed payment — the customer can simply start a new payment attempt.
 */

export type PaymentExpiredOrCancelledData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  amount: number; // centavos, the attempted amount
};

export function renderPaymentExpiredOrCancelled(d: PaymentExpiredOrCancelledData) {
  const subject = `Your payment window for order ${d.orderNumber} has closed`;
  const reason = reasonFor("order", d.brand);

  const body = `
    ${heading("Your payment wasn't completed")}
    ${paragraph(`Hi ${d.customerName}, the payment window for order ${d.orderNumber} closed before it was completed — either the session timed out or it was left without finishing checkout. Nothing was charged, and your order is still saved.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) +
        kvRow("Amount", peso(d.amount), { last: true }),
    )}
    ${button("Resume payment", d.orderUrl)}
    ${paragraph("Whenever you're ready, you can start a new payment for this order from your order page.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `The payment window for order ${d.orderNumber} closed before it was completed.`,
    reason,
  });

  const text = textBody([
    `Your payment wasn't completed`,
    ``,
    `Hi ${d.customerName}, the payment window for order ${d.orderNumber} closed before it`,
    `was completed — either the session timed out or it was left without finishing`,
    `checkout. Nothing was charged, and your order is still saved.`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Amount:       ${peso(d.amount)}`,
    ``,
    `Resume payment: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
