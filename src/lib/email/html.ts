/**
 * Email HTML primitives (Step 17; Axiaro master design — Batch 3 Phase 2).
 * Conservative, table-based, inline-styled HTML that renders on desktop, mobile
 * and legacy email clients (Outlook included) — no flexbox, grid, CSS variables
 * or web fonts. Single-column, ~600px, warm neutral palette.
 *
 * Every dynamic value passed into a template MUST go through `esc()` — customer
 * names, product names, addresses, notes etc. are untrusted and must never be
 * able to inject markup into an email.
 *
 * The written brand is "Axiaro" — it is never upper-cased programmatically.
 */

const PALETTE = {
  paper: "#faf7f2",
  surface: "#ffffff",
  ink: "#2b2926",
  inkSoft: "#5b564f",
  inkFaint: "#8a847a",
  line: "#e7e1d7",
  clay: "#b0563c",
} as const;

/** HTML-escape an untrusted string. */
export function esc(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Partially mask an email address for a security notice — keeps the first
 * character of the local part and the domain: `jane@example.com` -> `j***@example.com`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(3, local.length - 1))}${domain}`;
}

/** Peso formatting for centavos — plain, no Intl (stable across runtimes). */
export function peso(centavos: number): string {
  const n = Math.round(centavos) / 100;
  const [whole, frac] = n.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === "00" ? `₱${grouped}` : `₱${grouped}.${frac}`;
}

const SUPPORT_EMAIL = "support@axiaro.shop";

/**
 * "Why you received this" lines, by category. `{brand}` is substituted by
 * `reasonFor()` so the copy always reads "Axiaro" (or a store override).
 */
export const REASONS = {
  order: "You're receiving this because you placed an order with {brand}.",
  return: "You're receiving this because you requested a return with {brand}.",
  account: "You're receiving this because you have a {brand} account.",
  security: "You're receiving this because of security activity on your {brand} account.",
  support: "You're receiving this because you contacted {brand}.",
} as const;

export function reasonFor(kind: keyof typeof REASONS, brand: string): string {
  return REASONS[kind].replace("{brand}", brand);
}

/** "a" / "an" for a following word (used for "an Axiaro account"). */
export function article(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

export type LayoutOptions = {
  brand: string;
  siteUrl: string;
  previewText?: string;
  /**
   * "Why you received this" line, category-specific, e.g.
   * "You're receiving this because you placed an order with Axiaro."
   */
  reason?: string;
  /**
   * Account-security messages: the footer adds a "you can't reply / contact
   * support if you need help" line. The body still carries the specific
   * "if this wasn't you…" guidance.
   */
  security?: boolean;
  /**
   * Internal team notifications (support inbound, return inbound): a single
   * minimal footer line — no marketing, no legal block, no policy links.
   */
  internal?: boolean;
  /**
   * Legal entity name + registered address for the footer. Rendered only when
   * supplied — never invented. Both optional; the line is omitted if empty.
   */
  legal?: { name?: string | null; address?: string | null } | null;
};

function footerHtml(opts: LayoutOptions): string {
  const domain = opts.siteUrl.replace(/^https?:\/\//, "");
  const link = (href: string, text: string) =>
    `<a href="${esc(href)}" style="color:${PALETTE.inkFaint};text-decoration:underline;">${esc(text)}</a>`;

  if (opts.internal) {
    return `${esc(opts.brand)} · internal notification · ${link(opts.siteUrl, domain)}`;
  }

  const legalName = opts.legal?.name?.trim();
  const legalAddress = opts.legal?.address?.trim();
  const legalLine =
    legalName || legalAddress
      ? `<br>${esc([legalName, legalAddress].filter(Boolean).join(" · "))}`
      : "";

  const reasonLine = opts.reason ? `<br><br>${esc(opts.reason)}` : "";

  const securityLine = opts.security
    ? `<br><br>This is an automated security message — you can't reply to it. If you need help, email ${link(
        `mailto:${SUPPORT_EMAIL}`,
        SUPPORT_EMAIL,
      )}.`
    : "";

  return (
    `<strong style="color:${PALETTE.inkSoft};">${esc(opts.brand)}</strong><br>` +
    `${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)} &nbsp;·&nbsp; ${link(opts.siteUrl, domain)}` +
    legalLine +
    reasonLine +
    securityLine +
    `<br><br>${link(`${opts.siteUrl}/pages/privacy`, "Privacy")} &nbsp;·&nbsp; ${link(
      `${opts.siteUrl}/pages/terms`,
      "Terms",
    )}`
  );
}

/** Wraps body HTML in the branded shell. `bodyHtml` is already-escaped markup. */
export function layout(bodyHtml: string, opts: LayoutOptions): string {
  const preview = opts.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.previewText)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(opts.brand)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.paper};">
${preview}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.paper};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${PALETTE.surface};border:1px solid ${PALETTE.line};border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid ${PALETTE.line};">
            <a href="${esc(opts.siteUrl)}" style="text-decoration:none;color:${PALETTE.ink};font-size:19px;font-weight:700;letter-spacing:0.08em;">${esc(opts.brand)}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:${PALETTE.ink};font-size:15px;line-height:1.6;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px;border-top:1px solid ${PALETTE.line};color:${PALETTE.inkFaint};font-size:12px;line-height:1.7;">
            ${footerHtml(opts)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function heading(text: string): string {
  return `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${PALETTE.ink};font-weight:700;">${esc(text)}</h1>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;color:${PALETTE.inkSoft};">${esc(text)}</p>`;
}

/** A CTA button. `href` must already be a trusted absolute URL. */
export function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
    <tr><td style="border-radius:6px;background:${PALETTE.ink};">
      <a href="${esc(href)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/** A plain underlined text link for a secondary action (never a second button). */
export function textLink(label: string, href: string): string {
  return `<p style="margin:0 0 16px;font-size:13px;color:${PALETTE.inkSoft};">
    <a href="${esc(href)}" style="color:${PALETTE.clay};text-decoration:underline;">${esc(label)}</a>
  </p>`;
}

export function infoBox(rowsHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${PALETTE.line};border-radius:8px;">
    ${rowsHtml}
  </table>`;
}

export function kvRow(key: string, value: string, opts: { strong?: boolean; last?: boolean } = {}): string {
  const border = opts.last ? "" : `border-bottom:1px solid ${PALETTE.line};`;
  const weight = opts.strong ? "font-weight:700;" : "";
  return `<tr>
    <td style="padding:9px 14px;color:${PALETTE.inkFaint};font-size:13px;${border}">${esc(key)}</td>
    <td style="padding:9px 14px;color:${PALETTE.ink};font-size:13px;text-align:right;${weight}${border}">${esc(value)}</td>
  </tr>`;
}

export function itemsTable(
  items: { name: string; variantLabel?: string | null; quantity: number; unitPrice: number; lineTotal: number }[],
): string {
  const rows = items
    .map(
      (it) => `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid ${PALETTE.line};color:${PALETTE.ink};font-size:13px;">
          ${esc(it.name)}${it.variantLabel ? `<br><span style="color:${PALETTE.inkFaint};">${esc(it.variantLabel)}</span>` : ""}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${PALETTE.line};color:${PALETTE.inkSoft};font-size:13px;text-align:center;">${it.quantity}</td>
        <td style="padding:10px 8px;border-bottom:1px solid ${PALETTE.line};color:${PALETTE.inkSoft};font-size:13px;text-align:right;">${esc(peso(it.unitPrice))}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${PALETTE.line};color:${PALETTE.ink};font-size:13px;text-align:right;">${esc(peso(it.lineTotal))}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid ${PALETTE.line};border-radius:8px;overflow:hidden;">
    <tr style="background:${PALETTE.paper};">
      <td style="padding:9px 14px;color:${PALETTE.inkFaint};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;">Item</td>
      <td style="padding:9px 8px;color:${PALETTE.inkFaint};font-size:12px;text-align:center;">Qty</td>
      <td style="padding:9px 8px;color:${PALETTE.inkFaint};font-size:12px;text-align:right;">Price</td>
      <td style="padding:9px 14px;color:${PALETTE.inkFaint};font-size:12px;text-align:right;">Total</td>
    </tr>
    ${rows}
  </table>`;
}

/** Multi-line address block from a snapshot object. */
export function addressBlock(a: Record<string, unknown>): string {
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ") || String(a.recipient ?? "");
  const parts = [
    name,
    a.company,
    a.line1,
    a.line2,
    [a.barangay, a.city].filter(Boolean).join(", "),
    [a.province, a.postalCode].filter(Boolean).join(" "),
    a.country,
    a.phone,
  ].filter((p) => p && String(p).trim());
  return `<p style="margin:0 0 18px;color:${PALETTE.inkSoft};font-size:13px;line-height:1.7;">${parts
    .map((p) => esc(p))
    .join("<br>")}</p>`;
}

/** Build a plain-text version from lines (already plain, no markup). */
export function textBody(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Standard plain-text footer block for the customer emails. */
export function textFooter(brand: string, siteUrl: string, reason?: string): string[] {
  const domain = siteUrl.replace(/^https?:\/\//, "");
  return [
    ``,
    `--`,
    `${brand} · ${SUPPORT_EMAIL} · ${domain}`,
    ...(reason ? [reason] : []),
    `Privacy: ${siteUrl}/pages/privacy   Terms: ${siteUrl}/pages/terms`,
  ];
}
