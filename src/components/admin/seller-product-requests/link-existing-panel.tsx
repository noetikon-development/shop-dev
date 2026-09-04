"use client";

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { linkExistingProductAction, type RequestReviewState } from "@/lib/admin/seller-product-requests/actions";
import { notify, usePersistentAction } from "@/components/admin/ui";

type Match = {
  id: string;
  name: string;
  slug: string;
  status: string;
  categoryName: string | null;
  variantCount: number;
};

export function LinkExistingPanel({
  requestId,
  matches,
  query,
}: {
  requestId: string;
  matches: Match[];
  query: string;
}) {
  const { state, onSubmit, pending } = usePersistentAction<RequestReviewState>(linkExistingProductAction, {});
  const [selected, setSelected] = useState("");

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <div className="space-y-3">
      {/* search — GET, keeps the admin on this page */}
      <form method="get" className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            name="linkq"
            defaultValue={query}
            placeholder="Search products by name or SKU…"
            className="field py-1.5 pl-8 text-sm"
          />
        </div>
        <button type="submit" className="btn btn-outline py-1.5 text-xs">
          Search
        </button>
      </form>

      {query && matches.length === 0 && (
        <p className="text-xs text-ink-faint">No products match “{query}”.</p>
      )}

      {matches.length > 0 && (
        <form onSubmit={onSubmit} className="space-y-2">
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="productId" value={selected} />
          <ul className="divide-y divide-line-soft rounded-sm border border-line">
            {matches.map((m) => (
              <li key={m.id}>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-surface-sunken">
                  <input
                    type="radio"
                    name="pick"
                    value={m.id}
                    checked={selected === m.id}
                    onChange={() => setSelected(m.id)}
                    disabled={m.status === "ARCHIVED"}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">
                      {m.name}
                      {m.status === "ARCHIVED" && <span className="ml-1 text-xs text-danger">(archived)</span>}
                      {m.status === "DRAFT" && <span className="ml-1 text-xs text-ink-faint">(draft)</span>}
                    </span>
                    <span className="block text-xs text-ink-faint">
                      /{m.slug} · {m.categoryName ?? "no category"} · {m.variantCount} variant
                      {m.variantCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <textarea
            name="note"
            rows={2}
            maxLength={2000}
            placeholder="Optional note for the seller"
            className="field text-sm"
          />
          {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}
          <button type="submit" disabled={pending || !selected} className="btn btn-primary py-2 text-sm">
            {pending && <Loader2 size={14} className="animate-spin" />}
            Approve &amp; link to this product
          </button>
        </form>
      )}
    </div>
  );
}
