import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emailTemplateSchema } from "@/lib/content-blocks";
import {
  getEmailTemplateDef,
  emailTemplateBlockKey,
  type EmailToken,
} from "@/lib/email/template-registry";
import { layout, heading, paragraph, infoBox, kvRow, button, textBody, textFooter } from "@/lib/email/html";

/**
 * CMS email-template override resolver (Phase 9F-57).
 *
 * Reuses the existing `ContentBlock` CMS (see `content-blocks.ts`'s
 * `email_template` block type) — no second template-management system. A row
 * is addressed by the FIXED key `email.<templateKey>` (one row per template,
 * unlike the free-form homepage sections). Every read here is defensive: a
 * missing row, an unpublished row, a malformed payload, or an all-blank
 * payload is treated identically — "no usable override" — so the caller
 * always has a safe path back to its own hard-coded default. This module
 * NEVER throws for a data problem; it only throws `MissingReasonError`, which
 * is a deliberate signal (not a data problem) that the caller MUST route
 * through `failEmailPreparation` rather than silently proceeding.
 */

export type EmailTemplateOverride = {
  subject: string;
  heading: string;
  body: string;
  extraMessage: string;
  actionLabel: string;
};

/**
 * Read a template's CMS override. Returns `null` — never throws — when: the
 * templateKey is unknown, no row exists, the row isn't PUBLISHED, the row's
 * JSON is malformed / fails schema validation, or every field is blank (a
 * saved-but-empty row is indistinguishable from "no override" to a caller).
 */
export async function getEmailTemplateOverride(
  templateKey: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<EmailTemplateOverride | null> {
  if (!getEmailTemplateDef(templateKey)) return null;
  try {
    const row = await client.contentBlock.findUnique({
      where: { key: emailTemplateBlockKey(templateKey) },
      select: { status: true, type: true, data: true },
    });
    if (!row || row.status !== "PUBLISHED" || row.type !== "email_template") return null;
    let json: unknown;
    try {
      json = JSON.parse(row.data || "{}");
    } catch {
      return null;
    }
    const parsed = emailTemplateSchema.safeParse(json);
    if (!parsed.success) return null;
    const d = parsed.data;
    if (!d.subject && !d.heading && !d.body && !d.extraMessage && !d.actionLabel) return null;
    return d;
  } catch (err) {
    console.error("[email-templates] getEmailTemplateOverride failed", templateKey, err);
    return null;
  }
}

/**
 * Substitute `{{token}}` placeholders. A token not in `allowed` (unknown to
 * this template, or simply not one of the global `EMAIL_TOKENS`) is left as
 * literal text — never removed, never a render failure. A token that IS
 * allowed but has no supplied value substitutes to "" (never `undefined`
 * leaking into the output).
 */
export function substituteTokens(
  text: string,
  allowed: readonly EmailToken[],
  values: Partial<Record<EmailToken, string>>,
): string {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, token: string) => {
    if (!(allowed as readonly string[]).includes(token)) return whole;
    const v = values[token as EmailToken];
    return v == null ? "" : v;
  });
}

/** Raised when a `requiresReason` template is asked to render with no reason
 *  value — an impossible state the upstream action layer should have already
 *  blocked. The caller MUST catch this and route it through
 *  `failEmailPreparation`, never send a reason-less email, never invent text. */
export class MissingReasonError extends Error {}

const REASON_LINE: Record<"seller" | "customer" | "ops", string> = {
  seller: "You're receiving this because you manage a seller account on {brand}.",
  customer: "You're receiving this because you placed an order with {brand}.",
  ops: "You're receiving this because you're on the {brand} operations team.",
};

/**
 * A generic, template-derived fallback used ONLY when an override exists but
 * leaves a field blank — the registry's own `label` / `description` stand in
 * for that field so a partial customization never renders an empty line. This
 * is intentionally NOT the bespoke default copy the app's own `renderXxx()`
 * function produces (that copy is used verbatim, unchanged, whenever NO
 * override exists at all — see `renderAndDispatch`'s override branch in
 * `notifications.ts`). Exported so the admin preview can show the same
 * placeholder text a real send would fall back to.
 */
export function genericFallbackFor(templateKey: string): {
  subject: string;
  heading: string;
  body: string;
  extraMessage: string;
  actionLabel: string;
} {
  const def = getEmailTemplateDef(templateKey);
  return {
    subject: def?.label ?? "Notification",
    heading: def?.label ?? "Notification",
    body: def?.description ?? "",
    extraMessage: "",
    actionLabel: "Open",
  };
}

export type RenderEmailOverrideInput = {
  templateKey: string;
  override: EmailTemplateOverride;
  brand: string;
  siteUrl: string;
  tokenValues: Partial<Record<EmailToken, string>>;
  /** Used whenever the matching override field is blank. */
  fallback: { subject: string; heading: string; body: string; extraMessage?: string; actionLabel?: string };
  actionUrl?: string | null;
};

/**
 * Build a full {subject, html, text} email from a CMS override, falling back
 * per-FIELD (not all-or-nothing) to `fallback` for any blank override field.
 * The rejection/change-request "reason" is NEVER sourced from CMS text — it
 * is always the live `tokenValues.reason` value, rendered in its own labeled
 * box regardless of whether the admin's custom body even references
 * `{{reason}}`, so CMS wording can never invent, replace or hide it.
 */
export function renderEmailTemplateOverride(input: RenderEmailOverrideInput): {
  subject: string;
  html: string;
  text: string;
} {
  const def = getEmailTemplateDef(input.templateKey);
  const allowed = def?.allowedTokens ?? [];
  const requiresReason = def?.requiresReason ?? false;
  const reason = input.tokenValues.reason?.trim() ?? "";
  if (requiresReason && !reason) {
    throw new MissingReasonError(`template "${input.templateKey}" requires a reason but none was supplied`);
  }

  const pick = (overrideVal: string, fallbackVal: string) =>
    overrideVal && overrideVal.trim() ? overrideVal : fallbackVal;

  const subject = substituteTokens(pick(input.override.subject, input.fallback.subject), allowed, input.tokenValues);
  const headingText = substituteTokens(pick(input.override.heading, input.fallback.heading), allowed, input.tokenValues);
  const bodyText = substituteTokens(pick(input.override.body, input.fallback.body), allowed, input.tokenValues);
  const extraText = substituteTokens(
    pick(input.override.extraMessage, input.fallback.extraMessage ?? ""),
    allowed,
    input.tokenValues,
  );
  const actionLabel = substituteTokens(
    pick(input.override.actionLabel, input.fallback.actionLabel ?? "Open"),
    allowed,
    input.tokenValues,
  );

  const audience = def?.audience ?? "seller";
  const reasonLine = REASON_LINE[audience].replace("{brand}", input.brand);

  // `heading()` / `paragraph()` / `kvRow()` / `button()` all escape their text
  // arguments internally (src/lib/email/html.ts) — every one of these values,
  // CMS-authored or runtime-substituted, is HTML-escaped before it reaches the
  // output. No raw/trusted-HTML helper is used anywhere in this function.
  const bodyHtml = `
    ${heading(headingText)}
    ${paragraph(bodyText)}
    ${extraText ? paragraph(extraText) : ""}
    ${requiresReason ? infoBox(kvRow("Reason", reason, { last: true })) : ""}
    ${input.actionUrl && actionLabel ? button(actionLabel, input.actionUrl) : ""}
  `;

  const html = layout(bodyHtml, {
    brand: input.brand,
    siteUrl: input.siteUrl,
    previewText: subject,
    reason: reasonLine,
  });

  const text = textBody([
    headingText,
    ``,
    bodyText,
    ...(extraText ? [``, extraText] : []),
    ...(requiresReason ? [``, `Reason: ${reason}`] : []),
    ...(input.actionUrl && actionLabel ? [``, `${actionLabel}: ${input.actionUrl}`] : []),
    ...textFooter(input.brand, input.siteUrl, reasonLine),
  ]);

  return { subject, html, text };
}
