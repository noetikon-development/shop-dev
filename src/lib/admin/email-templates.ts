import "server-only";
import { prisma } from "@/lib/prisma";
import { emailTemplateSchema, type EmailTemplateData } from "@/lib/content-blocks";
import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_CATEGORIES,
  EMAIL_TEMPLATE_CATEGORY_LABELS,
  getEmailTemplateDef,
  emailTemplateBlockKey,
  type EmailTemplateDef,
} from "@/lib/email/template-registry";

/**
 * Admin reads for the Email Templates CMS screen (Phase 9F-57). Reuses the
 * `ContentBlock` table exactly as the footer / navigation / homepage editors
 * do — no separate table, no separate admin data layer beyond this thin
 * summary/detail shaping.
 */

export type EmailTemplateSummary = EmailTemplateDef & {
  /** True when a ContentBlock row exists at all (customized, whether live or not). */
  hasOverride: boolean;
  /** True when the override row is PUBLISHED — i.e. actually live. */
  published: boolean;
  updatedAt: string | null;
};

export async function listEmailTemplateSummaries(): Promise<
  { category: (typeof EMAIL_TEMPLATE_CATEGORIES)[number]; categoryLabel: string; templates: EmailTemplateSummary[] }[]
> {
  const rows = await prisma.contentBlock.findMany({
    where: { area: "email", type: "email_template" },
    select: { key: true, status: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const summaries: EmailTemplateSummary[] = EMAIL_TEMPLATES.map((def) => {
    const row = byKey.get(emailTemplateBlockKey(def.key));
    return {
      ...def,
      hasOverride: !!row,
      published: row?.status === "PUBLISHED",
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });

  return EMAIL_TEMPLATE_CATEGORIES.map((category) => ({
    category,
    categoryLabel: EMAIL_TEMPLATE_CATEGORY_LABELS[category],
    templates: summaries.filter((s) => s.category === category),
  }));
}

export type EmailTemplateEditState = {
  def: EmailTemplateDef;
  hasOverride: boolean;
  published: boolean;
  data: EmailTemplateData;
  updatedAt: string | null;
};

/** Loads a template's current CMS state for the editor. `data` is always a
 *  complete, schema-valid object (all-blank defaults when no override exists
 *  or the stored payload fails validation) — the editor never has to guard
 *  against partial/missing fields. */
export async function getEmailTemplateEditState(templateKey: string): Promise<EmailTemplateEditState | null> {
  const def = getEmailTemplateDef(templateKey);
  if (!def) return null;

  const row = await prisma.contentBlock.findUnique({
    where: { key: emailTemplateBlockKey(templateKey) },
    select: { status: true, type: true, data: true, updatedAt: true },
  });

  let data = emailTemplateSchema.parse({});
  if (row && row.type === "email_template") {
    try {
      const parsed = emailTemplateSchema.safeParse(JSON.parse(row.data || "{}"));
      if (parsed.success) data = parsed.data;
    } catch {
      /* malformed row → treat as blank, matches the resolver's own fallback */
    }
  }

  return {
    def,
    hasOverride: !!row,
    published: row?.status === "PUBLISHED",
    data,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}
