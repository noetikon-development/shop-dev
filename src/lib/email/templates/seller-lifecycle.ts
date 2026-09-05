import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody, textFooter } from "@/lib/email/html";

/**
 * Seller account + store-profile lifecycle notifications (Phase 9F-6b).
 *
 * Two recipient families:
 *  - Account (approved/suspended/closed) and profile-review (approved/rejected)
 *    emails go to the SELLER (OWNER / MANAGER + `Seller.notifyEmail`) — same
 *    audience as the seller product-request emails.
 *  - Profile-submitted goes to the Axiaro OPERATIONS inbox, never the seller —
 *    it is a "please review" nudge, not an outcome notice.
 *
 * The written brand is "Axiaro" — never upper-cased programmatically.
 */

type SellerBase = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  portalUrl: string;
};

const sellerReasonLine = "You're receiving this because you manage a seller account on {brand}.";
function sellerReason(brand: string) {
  return sellerReasonLine.replace("{brand}", brand);
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

export function renderSellerAccountApproved(d: SellerBase & { reactivate: boolean }) {
  const subject = d.reactivate ? `Your ${d.brand} seller account is active again` : `Your ${d.brand} seller account is approved`;
  const body = `
    ${heading(d.reactivate ? "Your seller account is active again" : "Your seller account is approved")}
    ${paragraph(
      d.reactivate
        ? `Good news — ${d.sellerName}'s seller account on ${d.brand} has been reactivated. You can sign back in to the seller portal.`
        : `Congratulations — ${d.sellerName}'s seller account on ${d.brand} has been approved.`,
    )}
    ${infoBox(kvRow("Seller", d.sellerName) + kvRow("Status", "Approved", { last: true }))}
    ${paragraph(
      d.reactivate
        ? "Your existing listings and settings are unchanged — pick up right where you left off."
        : "You can now sign in to the seller portal to set up your store profile and prepare listings.",
    )}
    ${button("Go to the seller portal", d.portalUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: sellerReason(d.brand) }),
    text: textBody([
      d.reactivate ? "Your seller account is active again" : "Your seller account is approved",
      ``,
      d.reactivate
        ? `Good news — ${d.sellerName}'s seller account on ${d.brand} has been reactivated. You can sign back in to the seller portal.`
        : `Congratulations — ${d.sellerName}'s seller account on ${d.brand} has been approved.`,
      ``,
      d.reactivate
        ? "Your existing listings and settings are unchanged — pick up right where you left off."
        : "You can now sign in to the seller portal to set up your store profile and prepare listings.",
      ``,
      `Seller portal: ${d.portalUrl}`,
      ...textFooter(d.brand, d.siteUrl, sellerReason(d.brand)),
    ]),
  };
}

export function renderSellerAccountSuspended(d: SellerBase) {
  const subject = `Your ${d.brand} seller account has been suspended`;
  const body = `
    ${heading("Your seller account is suspended")}
    ${paragraph(`${d.sellerName}'s seller account on ${d.brand} has been suspended.`)}
    ${infoBox(kvRow("Seller", d.sellerName) + kvRow("Status", "Suspended", { last: true }))}
    ${paragraph("While your account is suspended, you won't be able to sign in to the seller portal or make your listings available to customers.")}
    ${paragraph("If you believe this is a mistake, reply to this email and Axiaro will follow up.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: sellerReason(d.brand) }),
    text: textBody([
      "Your seller account is suspended",
      ``,
      `${d.sellerName}'s seller account on ${d.brand} has been suspended.`,
      ``,
      "While your account is suspended, you won't be able to sign in to the seller portal or make your listings available to customers.",
      ``,
      "If you believe this is a mistake, reply to this email and Axiaro will follow up.",
      ...textFooter(d.brand, d.siteUrl, sellerReason(d.brand)),
    ]),
  };
}

export function renderSellerAccountClosed(d: SellerBase) {
  const subject = `Your ${d.brand} seller account has been closed`;
  const body = `
    ${heading("Your seller account is closed")}
    ${paragraph(`${d.sellerName}'s seller account on ${d.brand} has been closed.`)}
    ${infoBox(kvRow("Seller", d.sellerName) + kvRow("Status", "Closed", { last: true }))}
    ${paragraph("This is a terminal state — you won't be able to sign in to the seller portal, and your listings are no longer available to customers.")}
    ${paragraph("If you have questions about this decision, reply to this email.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: sellerReason(d.brand) }),
    text: textBody([
      "Your seller account is closed",
      ``,
      `${d.sellerName}'s seller account on ${d.brand} has been closed.`,
      ``,
      "This is a terminal state — you won't be able to sign in to the seller portal, and your listings are no longer available to customers.",
      ``,
      "If you have questions about this decision, reply to this email.",
      ...textFooter(d.brand, d.siteUrl, sellerReason(d.brand)),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Store-profile moderation
// ---------------------------------------------------------------------------

export function renderSellerProfileApproved(d: SellerBase) {
  const subject = `Your ${d.brand} store profile was approved`;
  const body = `
    ${heading("Your store profile was approved")}
    ${paragraph(`Axiaro reviewed and approved ${d.sellerName}'s store profile.`)}
    ${button("View your seller settings", d.portalUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: sellerReason(d.brand) }),
    text: textBody([
      "Your store profile was approved",
      ``,
      `Axiaro reviewed and approved ${d.sellerName}'s store profile.`,
      ``,
      `Seller settings: ${d.portalUrl}`,
      ...textFooter(d.brand, d.siteUrl, sellerReason(d.brand)),
    ]),
  };
}

export function renderSellerProfileRejected(d: SellerBase & { reviewNote: string | null }) {
  const subject = `Changes needed: your ${d.brand} store profile`;
  const noteHtml = d.reviewNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.reviewNote).replace(/\n/g, "<br>")}</p>`
    : "";
  const body = `
    ${heading("Axiaro asked for changes to your store profile")}
    ${paragraph(`Axiaro reviewed ${d.sellerName}'s store profile and sent it back with some notes.`)}
    ${noteHtml}
    ${paragraph("Open your seller settings, make the changes and submit it again for review.")}
    ${button("Update your store profile", d.portalUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: sellerReason(d.brand) }),
    text: textBody([
      "Axiaro asked for changes to your store profile",
      ``,
      `Axiaro reviewed ${d.sellerName}'s store profile and sent it back with some notes.`,
      ...(d.reviewNote ? [``, d.reviewNote] : []),
      ``,
      "Open your seller settings, make the changes and submit it again for review.",
      ``,
      `Seller settings: ${d.portalUrl}`,
      ...textFooter(d.brand, d.siteUrl, sellerReason(d.brand)),
    ]),
  };
}

/** Ops-inbox notice — a seller's store profile is waiting on review. NOT a seller-facing email. */
export function renderSellerProfileSubmitted(d: { brand: string; siteUrl: string; sellerName: string; reviewUrl: string }) {
  const subject = `Seller profile ready for review: ${d.sellerName}`;
  const body = `
    ${heading("A seller profile is ready for review")}
    ${paragraph(`${d.sellerName} submitted its store profile for review.`)}
    ${infoBox(kvRow("Seller", d.sellerName, { last: true }))}
    ${button("Review the profile", d.reviewUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: "You're receiving this because you're on the Axiaro operations team." }),
    text: textBody([
      "A seller profile is ready for review",
      ``,
      `${d.sellerName} submitted its store profile for review.`,
      ``,
      `Review the profile: ${d.reviewUrl}`,
      ...textFooter(d.brand, d.siteUrl, "You're receiving this because you're on the Axiaro operations team."),
    ]),
  };
}
