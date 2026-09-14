"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { prisma } from "@/lib/prisma";
import { emailTemplateSchema } from "@/lib/content-blocks";
import { getEmailTemplateDef, emailTemplateBlockKey, EMAIL_TOKENS, type EmailToken } from "@/lib/email/template-registry";
import { renderEmailTemplateOverride, genericFallbackFor, MissingReasonError } from "@/lib/email/template-overrides";

/**
 * Admin CRUD + preview for CMS email-template overrides (Phase 9F-57). Reuses
 * the exact `ContentBlock` write pattern `content-block-actions.ts` already
 * established (validate → upsert → `writeAudit` → revalidate) — this is a
 * dedicated action set (not the generic `createBlockAction`/`updateBlockAction`)
 * only because email templates need a FIXED, predictable key per template
 * (`email.<templateKey>`) rather than homepage's freeform multi-instance keys.
 */

export type EmailTemplateActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

function revalidate(templateKey: string) {
  revalidatePath("/admin/content/email-templates");
  revalidatePath(`/admin/content/email-templates/${templateKey}`);
}

const saveSchema = z.object({
  templateKey: z.string().min(1).max(80),
  subject: z.string().max(200).default(""),
  heading: z.string().max(200).default(""),
  body: z.string().max(2000).default(""),
  extraMessage: z.string().max(2000).default(""),
  actionLabel: z.string().max(200).default(""),
  published: z.boolean().default(false),
});

export async function saveEmailTemplateAction(
  _prev: EmailTemplateActionState,
  formData: FormData,
): Promise<EmailTemplateActionState> {
  const admin = await requirePermission("manage_content");

  const parsed = saveSchema.safeParse({
    templateKey: String(formData.get("templateKey") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    heading: String(formData.get("heading") ?? ""),
    body: String(formData.get("body") ?? ""),
    extraMessage: String(formData.get("extraMessage") ?? ""),
    actionLabel: String(formData.get("actionLabel") ?? ""),
    published: formData.get("published") === "on" || formData.get("published") === "true",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const def = getEmailTemplateDef(parsed.data.templateKey);
  if (!def) return { ok: false, error: "Unknown email template." };

  const payload = emailTemplateSchema.safeParse({
    subject: parsed.data.subject,
    heading: parsed.data.heading,
    body: parsed.data.body,
    extraMessage: parsed.data.extraMessage,
    actionLabel: parsed.data.actionLabel,
  });
  if (!payload.success) {
    return { ok: false, error: payload.error.issues[0]?.message ?? "That content is invalid." };
  }

  const key = emailTemplateBlockKey(parsed.data.templateKey);
  const status = parsed.data.published ? "PUBLISHED" : "DRAFT";
  const existing = await prisma.contentBlock.findUnique({ where: { key }, select: { id: true, status: true } });
  const becamePublished = status === "PUBLISHED" && existing?.status !== "PUBLISHED";
  const becameUnpublished = status === "DRAFT" && existing?.status === "PUBLISHED";

  await prisma.contentBlock.upsert({
    where: { key },
    create: {
      key,
      area: "email",
      type: "email_template",
      title: def.label,
      data: JSON.stringify(payload.data),
      status,
    },
    update: {
      title: def.label,
      data: JSON.stringify(payload.data),
      status,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: becamePublished
      ? "content.email_template_published"
      : becameUnpublished
        ? "content.email_template_unpublished"
        : "content.email_template_updated",
    targetType: "content_block",
    targetId: key,
    summary: `${admin.user.email} ${becamePublished ? "published" : becameUnpublished ? "unpublished" : "updated"} the "${def.label}" email template`,
    meta: { templateKey: def.key, status },
  });

  revalidate(parsed.data.templateKey);
  return { ok: true };
}

export async function resetEmailTemplateAction(input: unknown): Promise<EmailTemplateActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = z.object({ templateKey: z.string().min(1).max(80) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const def = getEmailTemplateDef(parsed.data.templateKey);
  if (!def) return { ok: false, error: "Unknown email template." };

  const key = emailTemplateBlockKey(parsed.data.templateKey);
  const existing = await prisma.contentBlock.findUnique({ where: { key }, select: { id: true } });
  if (!existing) return { ok: true }; // already at default — nothing to do

  await prisma.contentBlock.delete({ where: { id: existing.id } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.email_template_reset",
    targetType: "content_block",
    targetId: key,
    summary: `${admin.user.email} reset the "${def.label}" email template to its application default`,
    meta: { templateKey: def.key },
  });

  revalidate(parsed.data.templateKey);
  return { ok: true };
}

/**
 * Sample values for every token, used ONLY for the admin preview — never
 * shown to a real seller/customer. Deliberately fictional and clearly
 * example-shaped (a recognizable placeholder order number, etc.).
 */
const SAMPLE_TOKEN_VALUES: Record<EmailToken, string> = {
  sellerName: "Style Avenue",
  storeName: "Axiaro",
  orderNumber: "AX-260101-100123",
  productName: "Linen Blend Relaxed Shirt",
  status: "Awaiting acceptance",
  reason: "Business registration could not be verified.",
  carrier: "J&T Express",
  trackingNumber: "JT1234567890PH",
  refundAmount: "₱500.00",
  settlementAmount: "₱12,345.00",
  actionUrl: "https://axiaro.shop/seller/orders/sample",
};

export type EmailTemplatePreview = { subject: string; html: string; text: string };

/**
 * Render a PREVIEW with sample data — never calls `dispatchEmail`, never
 * writes an `EmailLog` row, never sends anything. Renders the SUBMITTED
 * (possibly unsaved) form values, so an admin can see a draft before saving.
 * Falls back to the generic per-template placeholder for any blank field,
 * exactly like a real send would.
 */
export async function previewEmailTemplateAction(
  formData: FormData,
): Promise<{ ok: true; preview: EmailTemplatePreview } | { ok: false; error: string }> {
  await requirePermission("manage_content");

  const parsed = saveSchema.omit({ published: true }).safeParse({
    templateKey: String(formData.get("templateKey") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    heading: String(formData.get("heading") ?? ""),
    body: String(formData.get("body") ?? ""),
    extraMessage: String(formData.get("extraMessage") ?? ""),
    actionLabel: String(formData.get("actionLabel") ?? ""),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const def = getEmailTemplateDef(parsed.data.templateKey);
  if (!def) return { ok: false, error: "Unknown email template." };

  const tokenValues: Partial<Record<EmailToken, string>> = {};
  for (const token of EMAIL_TOKENS) tokenValues[token] = SAMPLE_TOKEN_VALUES[token];

  try {
    const rendered = renderEmailTemplateOverride({
      templateKey: def.key,
      override: {
        subject: parsed.data.subject,
        heading: parsed.data.heading,
        body: parsed.data.body,
        extraMessage: parsed.data.extraMessage,
        actionLabel: parsed.data.actionLabel,
      },
      brand: SAMPLE_TOKEN_VALUES.storeName,
      siteUrl: "https://axiaro.shop",
      tokenValues,
      fallback: genericFallbackFor(def.key),
      actionUrl: def.hasActionButton ? SAMPLE_TOKEN_VALUES.actionUrl : null,
    });
    return { ok: true, preview: rendered };
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return { ok: false, error: "This template requires a {{reason}} — the preview uses a sample one, so this shouldn't happen. Please report this." };
    }
    console.error("[email-templates] previewEmailTemplateAction failed", err);
    return { ok: false, error: "Could not render a preview." };
  }
}
