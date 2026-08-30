"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";

/**
 * Content-page administration (Step 16). Requires `manage_content`. Pages are
 * stored in the existing `ContentPage` model. The body is Markdown, rendered to
 * React elements by `src/lib/markdown.tsx` (no HTML passthrough, no
 * `dangerouslySetInnerHTML`), so page content cannot inject markup or scripts.
 */

export type PageActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdId?: string;
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const baseSchema = z.object({
  title: z.string().trim().min(2, "Enter a title.").max(160),
  slug: z.string().trim().min(1).max(64),
  excerpt: z.string().trim().max(400).optional(),
  body: z.string().max(50_000),
  seoTitle: z.string().trim().max(160).optional(),
  seoDescription: z.string().trim().max(320).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]),
});

function readForm(fd: FormData) {
  const s = (k: string) => String(fd.get(k) ?? "");
  return {
    title: s("title"),
    slug: s("slug").toLowerCase(),
    excerpt: s("excerpt") || undefined,
    body: s("body"),
    seoTitle: s("seoTitle") || undefined,
    seoDescription: s("seoDescription") || undefined,
    status: (s("status") || "DRAFT") as "DRAFT" | "PUBLISHED",
  };
}

function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

function toData(d: z.infer<typeof baseSchema>) {
  return {
    title: cleanUserText(d.title),
    slug: d.slug,
    excerpt: d.excerpt ? cleanUserText(d.excerpt) : null,
    // cleanUserText keeps Markdown newlines/tabs but strips control characters.
    body: cleanUserText(d.body),
    seoTitle: d.seoTitle ? cleanUserText(d.seoTitle) : null,
    seoDescription: d.seoDescription ? cleanUserText(d.seoDescription) : null,
    status: d.status,
  };
}

function revalidate(slug?: string) {
  revalidateTag("content", "max");
  revalidatePath("/admin/content/pages");
  if (slug) revalidatePath(`/pages/${slug}`);
  revalidatePath("/", "layout");
}

export async function createPageAction(
  _prev: PageActionState,
  formData: FormData,
): Promise<PageActionState> {
  const admin = await requirePermission("manage_content");

  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  if (!SLUG_RE.test(parsed.data.slug)) {
    return { ok: false, fieldErrors: { slug: "Lowercase letters, numbers and dashes only." } };
  }
  const exists = await prisma.contentPage.findUnique({ where: { slug: parsed.data.slug }, select: { id: true } });
  if (exists) return { ok: false, fieldErrors: { slug: "A page with that slug already exists." } };

  const data = toData(parsed.data);
  const created = await prisma.contentPage.create({
    data: { ...data, publishedAt: data.status === "PUBLISHED" ? new Date() : null },
    select: { id: true, slug: true, title: true, status: true },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.page_created",
    targetType: "content_page",
    targetId: created.id,
    summary: `${admin.user.email} created page "${created.title}" (${created.status})`,
    meta: { slug: created.slug, status: created.status },
  });

  revalidate(created.slug);
  return { ok: true, createdId: created.id };
}

export async function updatePageAction(
  _prev: PageActionState,
  formData: FormData,
): Promise<PageActionState> {
  const admin = await requirePermission("manage_content");

  const id = String(formData.get("id") ?? "");
  const current = await prisma.contentPage.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "That page wasn't found." };

  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  if (!SLUG_RE.test(parsed.data.slug)) {
    return { ok: false, fieldErrors: { slug: "Lowercase letters, numbers and dashes only." } };
  }
  if (parsed.data.slug !== current.slug) {
    const clash = await prisma.contentPage.findUnique({ where: { slug: parsed.data.slug }, select: { id: true } });
    if (clash) return { ok: false, fieldErrors: { slug: "A page with that slug already exists." } };
  }

  const data = toData(parsed.data);
  const becamePublished = data.status === "PUBLISHED" && current.status !== "PUBLISHED";
  await prisma.contentPage.update({
    where: { id },
    data: {
      ...data,
      publishedAt:
        data.status === "PUBLISHED" ? current.publishedAt ?? new Date() : current.publishedAt,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: becamePublished ? "content.page_published" : "content.page_updated",
    targetType: "content_page",
    targetId: id,
    summary: `${admin.user.email} ${becamePublished ? "published" : "updated"} page "${data.title}"`,
    meta: { slug: data.slug, status: data.status, previousSlug: current.slug },
  });

  revalidate(data.slug);
  if (current.slug !== data.slug) revalidatePath(`/pages/${current.slug}`);
  return { ok: true };
}

const idSchema = z.object({ id: z.string().min(1).max(64) });

export async function setPageStatusAction(input: unknown): Promise<PageActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = z.object({ id: z.string().min(1).max(64), status: z.enum(["DRAFT", "PUBLISHED"]) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.contentPage.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That page wasn't found." };
  if (current.status === parsed.data.status) return { ok: true };

  await prisma.contentPage.update({
    where: { id: parsed.data.id },
    data: {
      status: parsed.data.status,
      publishedAt: parsed.data.status === "PUBLISHED" ? current.publishedAt ?? new Date() : current.publishedAt,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: parsed.data.status === "PUBLISHED" ? "content.page_published" : "content.page_unpublished",
    targetType: "content_page",
    targetId: parsed.data.id,
    summary: `${admin.user.email} ${parsed.data.status === "PUBLISHED" ? "published" : "unpublished"} page "${current.title}"`,
    meta: { slug: current.slug },
  });

  revalidate(current.slug);
  return { ok: true };
}

export async function deletePageAction(input: unknown): Promise<PageActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.contentPage.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: true };

  await prisma.contentPage.delete({ where: { id: parsed.data.id } });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.page_deleted",
    targetType: "content_page",
    targetId: parsed.data.id,
    summary: `${admin.user.email} deleted page "${current.title}"`,
    meta: { slug: current.slug },
  });

  revalidate(current.slug);
  return { ok: true };
}
