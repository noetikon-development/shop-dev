"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import {
  createPageAction,
  updatePageAction,
  type PageActionState,
} from "@/lib/admin/content-page-actions";

const EMPTY: PageActionState = {};

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type PageDefaults = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  seoTitle: string | null;
  seoDescription: string | null;
  status: "DRAFT" | "PUBLISHED";
};

export function ContentPageForm({ page }: { page?: PageDefaults }) {
  const router = useRouter();
  const editing = Boolean(page);
  const { state, onSubmit, pending } = usePersistentAction<PageActionState>(
    editing ? updatePageAction : createPageAction,
    EMPTY,
  );
  const fe = state.fieldErrors ?? {};
  const doneRef = useRef(false);
  const [slug, setSlug] = useState(page?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(page));

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    if (state.createdId) {
      notify.success("Page created");
      router.push(`/admin/content/pages/${state.createdId}`);
    } else {
      notify.success("Page saved");
      router.refresh();
    }
  }, [state.ok, state.createdId, router]);
  useEffect(() => {
    if (state.error || state.fieldErrors) doneRef.current = false;
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {editing && <input type="hidden" name="id" value={page!.id} />}

      <Card>
        <h2 className="text-sm font-semibold text-ink">Page</h2>
        <div className="mt-3 space-y-4">
          <FormField label="Title" htmlFor="p-title" error={fe.title} required>
            <input
              id="p-title"
              name="title"
              required
              className="field"
              defaultValue={page?.title ?? ""}
              onChange={(e) => {
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          </FormField>
          <FormField
            label="Slug"
            htmlFor="p-slug"
            error={fe.slug}
            hint="The page lives at /pages/<slug>. Lowercase letters, numbers and dashes."
          >
            <input
              id="p-slug"
              name="slug"
              required
              className="field font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </FormField>
          <FormField label="Short summary" htmlFor="p-excerpt" error={fe.excerpt} hint="Shown under the title and used as the meta description fallback.">
            <input id="p-excerpt" name="excerpt" className="field" defaultValue={page?.excerpt ?? ""} />
          </FormField>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Content</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Markdown: <code># Heading</code>, <code>**bold**</code>, <code>- lists</code>,{" "}
          <code>[links](/path)</code>. HTML is not rendered.
        </p>
        <FormField label="Body" htmlFor="p-body" error={fe.body}>
          <textarea
            id="p-body"
            name="body"
            rows={16}
            className="field font-mono text-sm"
            defaultValue={page?.body ?? ""}
          />
        </FormField>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">SEO</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="SEO title" htmlFor="p-seo-title" error={fe.seoTitle} hint="Defaults to the page title.">
            <input id="p-seo-title" name="seoTitle" className="field" defaultValue={page?.seoTitle ?? ""} />
          </FormField>
          <FormField label="SEO description" htmlFor="p-seo-desc" error={fe.seoDescription} hint="Defaults to the summary.">
            <input id="p-seo-desc" name="seoDescription" className="field" defaultValue={page?.seoDescription ?? ""} />
          </FormField>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Status</h2>
        <FormField label="Publication" htmlFor="p-status" hint="Only published pages are visible on the storefront.">
          <Select id="p-status" name="status" defaultValue={page?.status ?? "DRAFT"}>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </Select>
        </FormField>
      </Card>

      {state.error && !state.fieldErrors && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push("/admin/content/pages")}
          className="btn btn-outline py-2 text-sm"
        >
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          {editing ? "Save changes" : "Create page"}
        </button>
      </div>
    </form>
  );
}
