"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Card, FormField, notify, usePersistentAction } from "@/components/admin/ui";
import { MediaPickerField } from "@/components/admin/media/media-picker";
import { AUTH_ARTWORK_IMAGE_SPEC } from "@/lib/media-constants";
import { saveAuthArtworkAction } from "@/lib/admin/content-auth-artwork-actions";
import {
  AUTH_ARTWORK_DEFAULTS,
  type AuthArtworkActionState,
} from "@/lib/auth-artwork-defaults";
import type { AuthArtworkData } from "@/lib/content-blocks";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

const EMPTY: AuthArtworkActionState = {};

/**
 * Edits the single `auth.artwork` ContentBlock. The image is a MediaAsset
 * chosen through the shared media picker; this form only carries the id, an
 * alt-text override and the on/off switch. When nothing is enabled the auth
 * screens keep their built-in `ProductArt` sofa illustration.
 */
export function AuthArtworkEditor({
  initial,
  assets,
  canManage,
}: {
  initial: AuthArtworkData | null;
  assets: PickerAsset[];
  canManage: boolean;
}) {
  const { state, onSubmit, pending } = usePersistentAction<AuthArtworkActionState>(
    saveAuthArtworkAction,
    EMPTY,
  );
  const doneRef = useRef(false);

  const [data, setData] = useState<AuthArtworkData>(initial ?? AUTH_ARTWORK_DEFAULTS);

  useEffect(() => {
    if (state.ok && !doneRef.current) {
      doneRef.current = true;
      notify.success("Authentication artwork saved");
    }
    if (state.error) doneRef.current = false;
  }, [state]);

  const set = <K extends keyof AuthArtworkData>(key: K, value: AuthArtworkData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === data.imageMediaId) ?? null,
    [assets, data.imageMediaId],
  );

  const previewAlt = data.alt || selectedAsset?.alt || "";
  const showsCustom = data.enabled && Boolean(data.imageMediaId);

  return (
    <Card>
      <form
        onSubmit={(e) => {
          const form = e.currentTarget;
          (form.elements.namedItem("data") as HTMLInputElement).value = JSON.stringify(data);
          onSubmit(e);
        }}
        className="space-y-8"
      >
        <input type="hidden" name="data" defaultValue="{}" />

        <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-6">
            <MediaPickerField
              name="__authArtworkImage"
              label="Artwork image"
              assets={assets}
              defaultValue={data.imageMediaId}
              uploadFolder="auth"
              showSpecHints
              spec={AUTH_ARTWORK_IMAGE_SPEC}
              hint="Shown on the right-hand side of the desktop sign-in and sign-up screens. Portrait 4:5 works best."
              onValueChange={(id) => set("imageMediaId", id)}
            />

            <FormField
              label="Alt text"
              htmlFor="auth-art-alt"
              hint="Describe the image for screen readers. Leave blank to treat it as decorative (recommended for a plain brand/lifestyle image beside the form)."
            >
              <input
                id="auth-art-alt"
                disabled={!canManage}
                maxLength={200}
                className="field text-sm"
                value={data.alt}
                onChange={(e) => set("alt", e.target.value)}
              />
            </FormField>

            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                disabled={!canManage}
                className="mt-0.5 accent-ink"
                checked={data.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              <span>
                Use this image on the authentication screens
                <span className="block text-xs text-ink-faint">
                  When off (or no image is chosen), the built-in Axiaro sofa illustration is used.
                </span>
              </span>
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">Preview</p>
            <div className="relative aspect-[4/5] w-full overflow-hidden rounded-md border border-line bg-surface-sunken">
              {showsCustom && selectedAsset ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selectedAsset.url}
                  alt={previewAlt}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center px-4 text-center text-xs text-ink-faint">
                  {data.imageMediaId && !data.enabled
                    ? "Image selected but not enabled — the built-in sofa illustration is shown on the storefront."
                    : "No custom image — the built-in Axiaro sofa illustration is shown on the storefront."}
                </div>
              )}
            </div>
            <p className="text-xs text-ink-faint">
              The art column is desktop-only ({"≥"} 1024&nbsp;px) and is exactly 4:5 at 1280 and
              1440&nbsp;px. The tagline stays in Settings → Store identity.
            </p>
          </div>
        </div>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        {canManage && (
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setData(AUTH_ARTWORK_DEFAULTS)}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
            >
              <RotateCcw size={13} /> Reset to built-in illustration
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Save artwork
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
