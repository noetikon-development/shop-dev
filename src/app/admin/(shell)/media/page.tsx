import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listMedia } from "@/lib/admin/media";
import {
  PageHeader,
  Card,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { MediaUploader } from "@/components/admin/media/media-uploader";
import { MediaGrid } from "@/components/admin/media/media-grid";

export const metadata: Metadata = { title: "Media" };

const KIND_OPTIONS = [
  { value: "image", label: "Images" },
  { value: "pdf", label: "PDFs" },
];

export default async function AdminMediaPage({ searchParams }: PageProps<"/admin/media">) {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const folder = str(sp.folder);
  const kind = str(sp.kind) as "image" | "pdf" | undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, pageCount, page: current, folders } = await listMedia({ q, folder, kind, page });
  const searching = Boolean(q || folder || kind);

  return (
    <div>
      <PageHeader
        title="Media"
        description="Images and files used across products, categories and content. Stored in Supabase Storage; only metadata is kept in the database. Uploads are validated by their real contents, not their extension."
      />

      {canManage && (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">Upload</h2>
          <MediaUploader />
        </Card>
      )}

      <FilterBar>
        <SearchInput placeholder="Filename, description or folder…" />
        {folders.length > 0 && (
          <FilterSelect
            label="Folder"
            paramKey="folder"
            options={folders.map((f) => ({ value: f, label: f }))}
          />
        )}
        <FilterSelect label="Type" paramKey="kind" options={KIND_OPTIONS} allLabel="All" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} file{total === 1 ? "" : "s"}
        {searching && " match this filter"}
        {!canManage && " · read-only (needs manage_content)"}
      </p>

      <MediaGrid
        assets={rows.map((a) => ({
          id: a.id,
          url: a.url,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          folder: a.folder,
          alt: a.alt,
          createdAt: a.createdAt.toISOString(),
        }))}
        canManage={canManage}
      />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
