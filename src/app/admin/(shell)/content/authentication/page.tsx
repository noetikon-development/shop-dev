import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { authArtworkSchema } from "@/lib/content-blocks";
import { AUTH_ARTWORK_BLOCK_KEY } from "@/lib/auth-artwork-defaults";
import { getPickerAssets } from "@/lib/admin/media-picker-data";
import { PageHeader } from "@/components/admin/ui";
import { AuthArtworkEditor } from "@/components/admin/content/auth-artwork-editor";

export const metadata: Metadata = { title: "Authentication" };

export default async function AdminAuthArtworkContentPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");

  const [row, assets] = await Promise.all([
    prisma.contentBlock.findUnique({
      where: { key: AUTH_ARTWORK_BLOCK_KEY },
      select: { data: true },
    }),
    getPickerAssets(),
  ]);

  let initial = null;
  if (row) {
    try {
      const parsed = authArtworkSchema.safeParse(JSON.parse(row.data || "{}"));
      if (parsed.success) initial = parsed.data;
    } catch {
      /* fall back to defaults in the editor */
    }
  }

  return (
    <div>
      <Link
        href="/admin/content"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Authentication"
        description="The large illustration on the desktop sign-in, sign-up and password screens. Choose one image, set its alt text and switch it on — or leave it off to keep the built-in Axiaro illustration. The tagline is edited in Settings → Store identity. Changes go live within a minute, no redeploy."
      />
      <AuthArtworkEditor initial={initial} assets={assets} canManage={canManage} />
    </div>
  );
}
