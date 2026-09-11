import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Payment failed (9F-55). Fired ONLY by a signature-verified PayMongo
 * `payment.failed` webhook — never from a browser redirect. The order itself is
 * untouched (still PENDING_PAYMENT / NONE) so the customer can simply try again;
 * this email exists so a declined charge doesn't go unexplained.
 *
 * No card number, no token, no provider secret, no decline code jargon — just
 * the store's own order reference.
 */

export type PaymentFailedData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  amount: number; // centavos, the attempted amount
};

export function renderPaymentFailed(d: PaymentFailedData) {
  const subject = `We couldn't process your payment for order ${d.orderNumber}`;
  const reason = reasonFor("order", d.brand);

  const body = `
    ${heading("Your payment wasn't completed")}
    ${paragraph(`Hi ${d.customerName}, we weren't able to process your payment for order ${d.orderNumber}. Nothing was charged, and your order is still saved — you can try paying again whenever you're ready.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) +
        kvRow("Amount", peso(d.amount), { last: true }),
    )}
    ${button("Retry payment", d.orderUrl)}
    ${paragraph("This can happen if the card or wallet declined the charge, the details didn't match, or the attempt was cancelled partway through. If it keeps happening, your bank or GCash may have more detail, or you can reach out to our support team.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Your payment for order ${d.orderNumber} wasn't completed.`,
    reason,
  });

  const text = textBody([
    `Your payment wasn't completed`,
    ``,
    `Hi ${d.customerName}, we weren't able to process your payment for order ${d.orderNumber}.`,
    `Nothing was charged, and your order is still saved — you can try paying again whenever you're ready.`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Amount:       ${peso(d.amount)}`,
    ``,
    `Retry payment: ${d.orderUrl}`,
    ``,
    `This can happen if the card or wallet declined the charge, the details didn't`,
    `match, or the attempt was cancelled partway through.`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
