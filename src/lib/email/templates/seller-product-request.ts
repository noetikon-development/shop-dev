import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody, textFooter } from "@/lib/email/html";

/**
 * Seller product-request notifications (Phase 9F-5c Part 11).
 *
 * Recipients are the seller's OWNER / MANAGER members (+ `Seller.notifyEmail`) —
 * never a customer address. These carry NO token / secret. The seller portal is
 * the source of truth; the email is a nudge to open it.
 *
 * The written brand is "Axiaro" — never upper-cased programmatically.
 */

type Base = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  productName: string;
  requestUrl: string;
};

const reasonLine = "You're receiving this because you manage a seller account on {brand}.";
function reason(brand: string) {
  return reasonLine.replace("{brand}", brand);
}

export function renderSellerProductRequestSubmitted(d: Base) {
  const subject = `We received your product request: ${d.productName}`;
  const body = `
    ${heading("Product request received")}
    ${paragraph(`Thanks — Axiaro has your request to add "${d.productName}" to the catalog for ${d.sellerName}.`)}
    ${infoBox(kvRow("Product", d.productName) + kvRow("Seller", d.sellerName, { last: true }))}
    ${paragraph("An Axiaro reviewer will check it and either add it to the catalog, link it to an existing product, or come back to you with changes. You'll get an email when that happens.")}
    ${button("View the request", d.requestUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Axiaro received your request for "${d.productName}".`, reason: reason(d.brand) }),
    text: textBody([
      `Product request received`,
      ``,
      `Thanks — Axiaro has your request to add "${d.productName}" to the catalog for ${d.sellerName}.`,
      ``,
      `An Axiaro reviewer will check it and either add it to the catalog, link it to an existing product, or come back to you with changes. You'll get an email when that happens.`,
      ``,
      `View the request: ${d.requestUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason(d.brand)),
    ]),
  };
}

export function renderSellerProductRequestApproved(
  d: Base & { linked: boolean; listUrl: string | null; reviewNote: string | null },
) {
  const subject = `Approved: ${d.productName}`;
  const noteHtml = d.reviewNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.reviewNote).replace(/\n/g, "<br>")}</p>`
    : "";
  const body = `
    ${heading("Your product request was approved")}
    ${paragraph(
      d.linked
        ? `Axiaro linked your request for "${d.productName}" to an existing catalog product.`
        : `Axiaro added "${d.productName}" to the catalog.`,
    )}
    ${noteHtml}
    ${paragraph("You can now create a listing against it and set your own price, condition and stock. Your listing stays a draft until you publish it.")}
    ${d.listUrl ? button("Create your listing", d.listUrl) : button("Open the request", d.requestUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `"${d.productName}" is ready to list on Axiaro.`, reason: reason(d.brand) }),
    text: textBody([
      `Your product request was approved`,
      ``,
      d.linked
        ? `Axiaro linked your request for "${d.productName}" to an existing catalog product.`
        : `Axiaro added "${d.productName}" to the catalog.`,
      ...(d.reviewNote ? [``, d.reviewNote] : []),
      ``,
      `You can now create a listing against it and set your own price, condition and stock. Your listing stays a draft until you publish it.`,
      ``,
      `${d.listUrl ? `Create your listing: ${d.listUrl}` : `Open the request: ${d.requestUrl}`}`,
      ...textFooter(d.brand, d.siteUrl, reason(d.brand)),
    ]),
  };
}

export function renderSellerProductRequestRejected(
  d: Base & { outcome: "rejected" | "changes_requested"; reviewNote: string | null },
) {
  const changes = d.outcome === "changes_requested";
  const subject = changes ? `Changes needed: ${d.productName}` : `Not approved: ${d.productName}`;
  const noteHtml = d.reviewNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.reviewNote).replace(/\n/g, "<br>")}</p>`
    : "";
  const body = `
    ${heading(changes ? "Axiaro asked for changes" : "This request wasn't approved")}
    ${paragraph(
      changes
        ? `Axiaro reviewed your request for "${d.productName}" and sent it back as a draft with some notes.`
        : `Axiaro reviewed your request for "${d.productName}" and didn't add it to the catalog.`,
    )}
    ${noteHtml}
    ${paragraph(
      changes
        ? "Open the request, make the changes and submit it again."
        : "You're welcome to start a new request if you'd still like Axiaro to carry it.",
    )}
    ${button("Open the request", d.requestUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: reason(d.brand) }),
    text: textBody([
      changes ? "Axiaro asked for changes" : "This request wasn't approved",
      ``,
      changes
        ? `Axiaro reviewed your request for "${d.productName}" and sent it back as a draft with some notes.`
        : `Axiaro reviewed your request for "${d.productName}" and didn't add it to the catalog.`,
      ...(d.reviewNote ? [``, d.reviewNote] : []),
      ``,
      changes
        ? "Open the request, make the changes and submit it again."
        : "You're welcome to start a new request if you'd still like Axiaro to carry it.",
      ``,
      `Open the request: ${d.requestUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason(d.brand)),
    ]),
  };
}
