import {
  layout,
  heading,
  paragraph,
  paragraphHtml,
  esc,
  button,
  infoBox,
  kvRow,
  itemsTable,
  addressBlock,
  peso,
  textBody,
  textFooter,
} from "@/lib/email/html";

/**
 * Seller order/return notifications (Phase 9F-7b; 9F-14 adds the new-order one).
 *
 * Recipients are the seller's ACTIVE OWNER / MANAGER members (+
 * `Seller.notifyEmail`) — same audience as the account/profile lifecycle
 * emails (9F-6b).
 */

type SellerOrderBase = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  orderNumber: string;
  ordersUrl: string;
};

/**
 * A brand-new SellerOrder for the seller to fulfil (9F-14). Carries only what
 * the seller needs to pick, pack and ship: the Axiaro order number, the item(s),
 * the money that determines their payout basis, the payment method (COD orders
 * are collected on delivery — the seller is NOT owed payment on receipt), and
 * the delivery address. NO customer email / account name / billing / order grand
 * total.
 */
export function renderSellerOrderReceived(
  d: SellerOrderBase & {
    orderUrl: string;
    items: { name: string; variantLabel: string | null; quantity: number; unitPrice: number; lineTotal: number }[];
    merchandiseSubtotal: number;
    discountAllocated: number;
    shippingFee: number;
    payoutBasis: number;
    paymentMethodLabel: string;
    shipTo: Record<string, unknown> | null;
  },
) {
  const subject = `New order ${d.orderNumber} — ${d.sellerName}`;
  const money =
    kvRow("Merchandise", peso(d.merchandiseSubtotal)) +
    (d.discountAllocated > 0 ? kvRow("Discount", `− ${peso(d.discountAllocated)}`) : "") +
    kvRow("Shipping", d.shippingFee === 0 ? "Free" : peso(d.shippingFee)) +
    kvRow("Your payout basis", peso(d.payoutBasis), { strong: true }) +
    kvRow("Payment", d.paymentMethodLabel, { last: true });
  const body = `
    ${heading("You have a new order")}
    ${paragraph(`Order ${d.orderNumber} is ready for ${d.sellerName} to fulfil. Accept it in the Seller Portal to start preparing.`)}
    ${itemsTable(d.items)}
    ${infoBox(money)}
    ${heading("Deliver to")}
    ${d.shipTo ? addressBlock(d.shipTo) : paragraph("No delivery address on file — check the Seller Portal.")}
    ${button("Open order in Seller Portal", d.orderUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "You have a new order",
      ``,
      `Order ${d.orderNumber} is ready for ${d.sellerName} to fulfil.`,
      ``,
      ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""} — ${peso(i.lineTotal)}`),
      ``,
      `Merchandise: ${peso(d.merchandiseSubtotal)}`,
      ...(d.discountAllocated > 0 ? [`Discount: -${peso(d.discountAllocated)}`] : []),
      `Shipping: ${d.shippingFee === 0 ? "Free" : peso(d.shippingFee)}`,
      `Your payout basis: ${peso(d.payoutBasis)}`,
      `Payment: ${d.paymentMethodLabel}`,
      ``,
      "Deliver to:",
      ...(d.shipTo
        ? [d.shipTo.firstName, d.shipTo.lastName].filter(Boolean).join(" ")
          ? [
              [d.shipTo.firstName, d.shipTo.lastName].filter(Boolean).join(" "),
              String(d.shipTo.line1 ?? ""),
              String(d.shipTo.line2 ?? ""),
              [d.shipTo.barangay, d.shipTo.city].filter(Boolean).join(", "),
              [d.shipTo.province, d.shipTo.postalCode].filter(Boolean).join(" "),
              String(d.shipTo.country ?? ""),
              String(d.shipTo.phone ?? ""),
            ].filter((l) => l && l.trim())
          : ["(see the Seller Portal)"]
        : ["(see the Seller Portal)"]),
      ``,
      `Open the order: ${d.orderUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

/**
 * 9F-20 — a single line describing a post-settlement clawback, when the order
 * this email is about had already been included in a paid settlement. Purely
 * bookkeeping: nothing has been withdrawn; the amount is netted off the seller's
 * NEXT settlement. `null` (the common case) leaves the email unchanged.
 */
export type ClawbackNote = { amount: number; reason: "return" | "cancellation" } | null;

function clawbackHtml(c: NonNullable<ClawbackNote>): string {
  const why =
    c.reason === "return"
      ? "was returned after this order had already been settled"
      : "was cancelled after this order had already been settled";
  return (
    infoBox(
      kvRow("Already settled", "Yes") +
        kvRow("Amount to recover", `− ${peso(c.amount)}`, { strong: true, last: true }),
    ) +
    paragraph(
      `Because part of this order ${why}, ${peso(c.amount)} will be deducted from your next settlement. ` +
        `No money has been withdrawn — this is a bookkeeping adjustment only. You can see it under “Outstanding clawbacks” in the Seller Portal.`,
    )
  );
}
function clawbackText(c: NonNullable<ClawbackNote>): string[] {
  return [
    ``,
    `Already settled: yes`,
    `Amount to recover from your next settlement: -${peso(c.amount)}`,
    `No money has been withdrawn — this is a bookkeeping adjustment only.`,
  ];
}

export function renderSellerOrderCancelled(d: SellerOrderBase & { clawback?: ClawbackNote }) {
  const subject = `Order ${d.orderNumber} was cancelled`;
  const c = d.clawback ?? null;
  const body = `
    ${heading("An order was cancelled")}
    ${paragraph(`Order ${d.orderNumber}, which included items from ${d.sellerName}, was cancelled.`)}
    ${infoBox(kvRow("Order", d.orderNumber) + kvRow("Status", "Cancelled", { last: true }))}
    ${paragraph("No further action is needed on this order — any reserved stock has already been returned to your available inventory.")}
    ${c ? clawbackHtml(c) : ""}
    ${button("View your orders", d.ordersUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: "You're receiving this because you manage a seller account on {brand}.".replace("{brand}", d.brand) }),
    text: textBody([
      "An order was cancelled",
      ``,
      `Order ${d.orderNumber}, which included items from ${d.sellerName}, was cancelled.`,
      ``,
      "No further action is needed on this order — any reserved stock has already been returned to your available inventory.",
      ...(c ? clawbackText(c) : []),
      ``,
      `Your orders: ${d.ordersUrl}`,
      ...textFooter(d.brand, d.siteUrl, `You're receiving this because you manage a seller account on ${d.brand}.`),
    ]),
  };
}

export function renderSellerReturnReceived(
  d: SellerOrderBase & {
    returnNumber: string;
    returnsUrl: string;
    items: { name: string; variantLabel: string | null; quantity: number }[];
    clawback?: ClawbackNote;
  },
) {
  const subject = `Return received: ${d.returnNumber} (order ${d.orderNumber})`;
  const itemLines = d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`);
  const c = d.clawback ?? null;
  const body = `
    ${heading("A return was received")}
    ${paragraph(`Axiaro received the returned item(s) from order ${d.orderNumber} for ${d.sellerName}.`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Items", itemLines.join("; ") || "—", { last: true }),
    )}
    ${c ? clawbackHtml(c) : ""}
    ${button("View your returns", d.returnsUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: `You're receiving this because you manage a seller account on ${d.brand}.` }),
    text: textBody([
      "A return was received",
      ``,
      `Axiaro received the returned item(s) from order ${d.orderNumber} for ${d.sellerName}.`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Items: ${itemLines.join("; ") || "—"}`,
      ...(c ? clawbackText(c) : []),
      ``,
      `Your returns: ${d.returnsUrl}`,
      ...textFooter(d.brand, d.siteUrl, `You're receiving this because you manage a seller account on ${d.brand}.`),
    ]),
  };
}

/**
 * 9F-32A — a customer's order has been waiting for this THIRD_PARTY seller to
 * accept it for longer than the SLA reminder threshold. The order is confirmed
 * and paid-on-delivery — the customer is expecting it to move. Sent to the
 * seller (OWNER/MANAGER + notifyEmail). Deliberately does NOT say the order is
 * being packed; it says the seller must accept or decline it.
 *
 * Order/fulfilment metadata only — the customer's name/email/address are never
 * in this email (they are on the order detail page in the portal).
 */
export function renderSellerOrderAcceptanceReminder(
  d: SellerOrderBase & {
    orderUrl: string;
    waitedLabel: string;
    itemCount: number;
  },
) {
  const subject = `Action needed: accept or decline order ${d.orderNumber}`;
  const body = `
    ${heading("An order is waiting for you to accept it")}
    ${paragraphHtml(
      `Order ${esc(d.orderNumber)} for ${esc(d.sellerName)} has been waiting <strong>${esc(d.waitedLabel)}</strong> for you to accept it. The customer's order is confirmed and they're expecting it to move — it will not progress until you accept it in the Seller Portal.`,
    )}
    ${infoBox(
      kvRow("Order", d.orderNumber) +
        kvRow("Items", String(d.itemCount)) +
        kvRow("Waiting", d.waitedLabel) +
        kvRow("Status", "Awaiting your acceptance", { last: true }),
    )}
    ${paragraphHtml(
      "Open the order and either <strong>Accept</strong> it to start preparing, or <strong>Decline</strong> it if you can't fulfil it — declining cancels the customer's order and returns the stock.",
    )}
    ${button("Open the order", d.orderUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "An order is waiting for you to accept it",
      ``,
      `Order ${d.orderNumber} for ${d.sellerName} has been waiting ${d.waitedLabel} for you to accept it. The customer's order is confirmed and expecting it to move — it will not progress until you accept it in the Seller Portal.`,
      ``,
      `Order: ${d.orderNumber}`,
      `Items: ${d.itemCount}`,
      `Waiting: ${d.waitedLabel}`,
      `Status: Awaiting your acceptance`,
      ``,
      "Open the order and either Accept it to start preparing, or Decline it if you can't fulfil it (declining cancels the customer's order and returns the stock).",
      ``,
      `Open the order: ${d.orderUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

/**
 * 9F-31B (P2) — a customer opened a return that covers one or more of this
 * seller's lines. Sent the moment the return is CREATED (customer self-service
 * or admin-assisted), so the seller can expect the goods back and prepare a
 * resolution — the seller's own inspection / receipt confirmation happens later
 * via `renderSellerReturnReceived`.
 *
 * Carries ONLY return metadata the seller needs: the Axiaro order number, the
 * seller's own returned line(s), the reason, and the current status. NO customer
 * name / email / phone / address / note.
 */
export function renderSellerReturnRequested(
  d: SellerOrderBase & {
    returnNumber: string;
    returnsUrl: string;
    reasonLabel: string;
    status: string;
    items: { name: string; variantLabel: string | null; quantity: number }[];
  },
) {
  const subject = `Return requested: ${d.returnNumber} (order ${d.orderNumber})`;
  const itemLines = d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`);
  const body = `
    ${heading("A customer requested a return")}
    ${paragraph(`A customer opened a return that includes item(s) from ${d.sellerName}. Axiaro reviews every return request; you don't need to act yet — this is a heads-up so you can expect the item(s) back.`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Reason", d.reasonLabel) +
        kvRow("Status", d.status) +
        kvRow("Your item(s)", itemLines.join("; ") || "—", { last: true }),
    )}
    ${paragraph("You'll get another email once the returned item(s) are received back. Track it any time in the Seller Portal.")}
    ${button("View your returns", d.returnsUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "A customer requested a return",
      ``,
      `A customer opened a return that includes item(s) from ${d.sellerName}. Axiaro reviews every return request — you don't need to act yet.`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Reason: ${d.reasonLabel}`,
      `Status: ${d.status}`,
      `Your item(s): ${itemLines.join("; ") || "—"}`,
      ``,
      "You'll get another email once the returned item(s) are received back.",
      ``,
      `Your returns: ${d.returnsUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

/**
 * 9F-41B — Axiaro approved a return covering one or more of this seller's
 * lines. Sent right after approval (destination already frozen). Tells the
 * seller to expect the goods; when the return ships to THIS seller's own
 * address, `destinationLines` echoes exactly what the customer was told.
 * NO customer name / email / phone / address / note.
 */
export function renderSellerReturnApproved(
  d: SellerOrderBase & {
    returnNumber: string;
    returnsUrl: string;
    reasonLabel: string;
    items: { name: string; variantLabel: string | null; quantity: number }[];
    shipsToThisSeller: boolean;
    destinationLines: string[];
  },
) {
  const subject = `Return approved: ${d.returnNumber} (order ${d.orderNumber})`;
  const itemLines = d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`);
  const routingLine = d.shipsToThisSeller
    ? "The customer has been told to ship the item(s) to your return address."
    : "Axiaro is coordinating where the item(s) go — no action needed from you yet.";
  const destBox = d.shipsToThisSeller && d.destinationLines.length > 0
    ? infoBox(
        d.destinationLines
          .map((l, i) => kvRow(i === 0 ? "Ship to" : "", l, { last: i === d.destinationLines.length - 1 }))
          .join(""),
      )
    : "";
  const body = `
    ${heading("A return was approved")}
    ${paragraph(`Axiaro approved a return that includes item(s) from ${d.sellerName}. ${routingLine} Confirm receipt in your Seller Portal once the item(s) arrive.`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Reason", d.reasonLabel) +
        kvRow("Your item(s)", itemLines.join("; ") || "—", { last: true }),
    )}
    ${destBox}
    ${paragraph("Axiaro handles the customer refund. You'll get another email once you or Axiaro records the item(s) as received.")}
    ${button("View your returns", d.returnsUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "A return was approved",
      ``,
      `Axiaro approved a return that includes item(s) from ${d.sellerName}. ${routingLine}`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Reason: ${d.reasonLabel}`,
      `Your item(s): ${itemLines.join("; ") || "—"}`,
      ...(d.shipsToThisSeller && d.destinationLines.length > 0 ? [``, `Ship to:`, ...d.destinationLines] : []),
      ``,
      "Axiaro handles the customer refund. Confirm receipt in your Seller Portal once the item(s) arrive.",
      ``,
      `Your returns: ${d.returnsUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

/**
 * 9F-20 — a bookkeeping settlement was recorded for this THIRD_PARTY seller.
 *
 * IMPORTANT: this describes a RECORD Axiaro entered, not an electronic transfer.
 * Axiaro does not move money through the platform. If the admin entered an
 * external payment method / reference, that is shown as "how it was paid" — but
 * the email must never imply Axiaro/PayMongo deposited funds.
 *
 * Amounts use the LOCKED 9F-19 formula, all recomputed server-side on the
 * SellerSettlement row:
 *   grossReceivable  = Σ SellerOrder.total
 *   commissionAmount = Σ SellerOrder.commissionAmount
 *   receivableSubtotal = grossReceivable - commissionAmount
 *   clawbackAmount   = Σ outstanding clawbacks reconciled in this batch
 *   netAmount        = receivableSubtotal - clawbackAmount   (may be <= 0)
 *
 * No customer data, no other seller's data, no SellerOrder ids, no raw
 * settlement id in prose — the id appears only inside the deep-link URL.
 */
export function renderSellerSettlementRecorded(d: {
  brand: string;
  siteUrl: string;
  sellerName: string;
  settlementUrl: string;
  paidAt: string | null;
  grossReceivable: number;
  commissionAmount: number;
  clawbackAmount: number;
  netAmount: number;
  orderCount: number;
  clawbackCount: number;
  /** 9F-42B — residual this settlement carries to the seller's next one (>= 0). Optional (pre-9F-42B rows: 0). */
  carryForwardAmount?: number;
  paymentMethod: string | null;
  paymentReference: string | null;
  note: string | null;
}) {
  const subject = `Settlement recorded — ${peso(d.netAmount)}`;
  const carryOut = d.carryForwardAmount ?? 0;
  // 9F-42B — the balance carried IN from the seller's previous settlement,
  // derived from the row so no extra column is needed:
  //   netRaw = gross - commission - clawbackAmount - carryIn
  //   netAmount = max(0, netRaw)   carryOut = max(0, -netRaw)
  const carryIn = Math.max(0, d.grossReceivable - d.commissionAmount - d.clawbackAmount - d.netAmount + carryOut);
  // "Returns & clawbacks" — the row's clawbackAmount now also covers merchandise
  // returned before this batch was settled (9F-42B).
  const receivableSubtotal = d.grossReceivable - d.commissionAmount;
  const money =
    kvRow("Orders settled", String(d.orderCount)) +
    kvRow("Gross receivable", peso(d.grossReceivable)) +
    kvRow("Commission", `− ${peso(d.commissionAmount)}`) +
    kvRow("Receivable subtotal", peso(receivableSubtotal)) +
    (d.clawbackCount > 0
      ? kvRow(`Returns & clawbacks (${d.clawbackCount})`, `− ${peso(d.clawbackAmount)}`)
      : "") +
    (carryIn > 0 ? kvRow("Balance carried over from last settlement", `− ${peso(carryIn)}`) : "") +
    kvRow("Net settlement", peso(d.netAmount), { strong: true, last: carryOut === 0 }) +
    (carryOut > 0
      ? kvRow("Carried forward to your next settlement", peso(carryOut), { last: true })
      : "");
  const paidRows =
    (d.paidAt ? kvRow("Payment date", d.paidAt) : "") +
    (d.paymentMethod ? kvRow("Paid via", d.paymentMethod) : "") +
    (d.paymentReference ? kvRow("Reference", d.paymentReference, { last: true }) : "");
  const body = `
    ${heading("Axiaro has recorded a settlement")}
    ${paragraph(`Axiaro has recorded a seller settlement for ${d.sellerName}. This is a bookkeeping record of what Axiaro owes you for the orders listed below — it is not an electronic transfer through the platform.`)}
    ${infoBox(money)}
    ${paidRows ? `${paragraph("Payment recorded by Axiaro (made outside the platform — bank transfer, GCash or cash):")}${infoBox(paidRows)}` : paragraph("No external payment details were entered with this record.")}
    ${d.note ? paragraph(`Note from Axiaro: ${d.note}`) : ""}
    ${
      d.netAmount <= 0
        ? paragraph(
            carryOut > 0
              ? `Nothing is owed to you this cycle — returns and clawbacks exceeded the receivable. The remaining ${peso(carryOut)} will be deducted from your next settlement. No money has been withdrawn — this is a bookkeeping adjustment only.`
              : "The net amount for this period is zero because returns and clawbacks met the receivable. Nothing is owed to you this cycle.",
          )
        : carryOut > 0
          ? paragraph(`${peso(carryOut)} could not be covered by this settlement and will be deducted from your next one.`)
          : ""
    }
    ${button("View this settlement", d.settlementUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "Axiaro has recorded a settlement",
      ``,
      `Axiaro has recorded a seller settlement for ${d.sellerName}. This is a bookkeeping record of what Axiaro owes you — not an electronic transfer through the platform.`,
      ``,
      `Orders settled: ${d.orderCount}`,
      `Gross receivable: ${peso(d.grossReceivable)}`,
      `Commission: -${peso(d.commissionAmount)}`,
      `Receivable subtotal: ${peso(receivableSubtotal)}`,
      ...(d.clawbackCount > 0 ? [`Returns & clawbacks (${d.clawbackCount}): -${peso(d.clawbackAmount)}`] : []),
      ...(carryIn > 0 ? [`Balance carried over from last settlement: -${peso(carryIn)}`] : []),
      `Net settlement: ${peso(d.netAmount)}`,
      ...(carryOut > 0 ? [`Carried forward to your next settlement: ${peso(carryOut)}`] : []),
      ``,
      ...(paidRows
        ? [
            "Payment recorded by Axiaro (made outside the platform — bank transfer, GCash or cash):",
            ...(d.paidAt ? [`Payment date: ${d.paidAt}`] : []),
            ...(d.paymentMethod ? [`Paid via: ${d.paymentMethod}`] : []),
            ...(d.paymentReference ? [`Reference: ${d.paymentReference}`] : []),
          ]
        : ["No external payment details were entered with this record."]),
      ...(d.note ? [``, `Note from Axiaro: ${d.note}`] : []),
      ``,
      `View this settlement: ${d.settlementUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}
