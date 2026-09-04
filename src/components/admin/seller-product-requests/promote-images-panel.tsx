"use client";

import { useEffect } from "react";
import { Loader2, Check } from "lucide-react";
import {
  promoteRequestImageAction,
  type RequestReviewState,
} from "@/lib/admin/seller-product-requests/actions";
import { Select, notify, usePersistentAction } from "@/components/admin/ui";

type Img = {
  id: string;
  url: string;
  filename: string;
  role: string;
  sellerOwned: boolean;
  alreadyPromoted: boolean;
};

export function PromoteImagesPanel({
  requestId,
  images,
  colourChoices,
  productName,
}: {
  requestId: string;
  images: Img[];
  colourChoices: { id: string; value: string }[];
  productName: string;
}) {
  const { state, onSubmit, pending } = usePersistentAction<RequestReviewState>(
    promoteRequestImageAction,
    {},
  );

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-faint">
        Promote only the images you want as catalog images for {productName}. Each promoted image
        becomes a permanent ProductImage and its file is moved out of the seller&rsquo;s library.
        Nothing is promoted automatically.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.map((img) => (
          <div key={img.id} className="overflow-hidden rounded-sm border border-line">
            <div className="relative aspect-square bg-surface-sunken">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} className="h-full w-full object-contain" />
            </div>
            <div className="space-y-1.5 p-2">
              <p className="truncate text-[11px] text-ink-faint">{img.filename}</p>
              {img.alreadyPromoted ? (
                <p className="inline-flex items-center gap-1 text-[11px] text-sage">
                  <Check size={12} /> Promoted
                </p>
              ) : !img.sellerOwned ? (
                <p className="text-[11px] text-ink-faint">Not seller-owned — can&rsquo;t promote.</p>
              ) : (
                <form onSubmit={onSubmit} className="space-y-1.5">
                  <input type="hidden" name="requestId" value={requestId} />
                  <input type="hidden" name="imageId" value={img.id} />
                  {colourChoices.length > 0 && (
                    <Select name="optionValueId" defaultValue="" className="text-xs">
                      <option value="">All colours</option>
                      {colourChoices.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.value}
                        </option>
                      ))}
                    </Select>
                  )}
                  <button type="submit" disabled={pending} className="btn btn-outline w-full py-1.5 text-xs">
                    {pending && <Loader2 size={12} className="animate-spin" />}
                    Promote
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>
      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}
    </div>
  );
}
