import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listMedia } from "@/lib/admin/media";
import { PageHeader, Card } from "@/components/admin/ui";
import { MediaUploader } from "@/components/admin/media/media-uploader";
import { MediaGrid } from "@/components/admin/media/media-grid";

export const metadata: Metadata = { title: "Media" };

export default async function AdminMediaPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");
  const assets = await listMedia();

  return (
    <div>
      <PageHeader
        title="Media"
        description="Images and files used across products, categories and content. Files are stored in Supabase Storage; only metadata is kept in the database."
      />

      {canManage && (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">Upload</h2>
          <MediaUploader />
        </Card>
      )}

      <MediaGrid
        assets={assets.map((a) => ({
          id: a.id,
          url: a.url,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          folder: a.folder,
          createdAt: a.createdAt.toISOString(),
        }))}
        canManage={canManage}
      />
    </div>
  );
}
