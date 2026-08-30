/**
 * Media constraints — pure data, safe to import from client and server (Step 16).
 * The authoritative validation (magic-byte sniffing, path safety) lives in the
 * server-only `src/lib/admin/media.ts`; these are the shared limits the upload
 * UI advertises.
 */

/** Accepted, sniffable types. SVG is intentionally excluded (it can carry scripts). */
export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

export const ALLOWED_MEDIA_ACCEPT = ALLOWED_MEDIA_TYPES.join(",");

/** Image-only accept string, for pickers that don't want PDFs. */
export const ALLOWED_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Recommended standard for homepage hero panel images. These are ADVISORY —
 * they produce warnings in the admin, never a hard block. "Quality 82–85" is a
 * production recommendation for the person exporting the file; it is not an
 * attribute the server can read back from an encoded image, so it is not checked
 * here.
 */
export const HERO_IMAGE_SPEC = {
  width: 1600,
  height: 1600,
  minBytes: 150 * 1024,
  maxBytes: 500 * 1024,
  preferredType: "image/webp",
} as const;

export type ImageSpecWarning = string;

/**
 * Compare an image's known metadata against HERO_IMAGE_SPEC. Returns a list of
 * human-readable warnings (empty = within spec, or not enough info to judge).
 * width/height may be null for assets uploaded before dimensions were captured.
 */
export function heroImageWarnings(meta: {
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
}): ImageSpecWarning[] {
  const out: ImageSpecWarning[] = [];
  const { width, height, sizeBytes, mimeType } = meta;

  if (typeof width === "number" && typeof height === "number") {
    if (width !== height) {
      out.push(`not square (${width}×${height})`);
    } else if (width !== HERO_IMAGE_SPEC.width) {
      out.push(`${width}×${height} — recommended ${HERO_IMAGE_SPEC.width}×${HERO_IMAGE_SPEC.height}`);
    }
  }
  if (typeof sizeBytes === "number") {
    if (sizeBytes < HERO_IMAGE_SPEC.minBytes) {
      out.push(`${Math.round(sizeBytes / 1024)} KB — below the ${HERO_IMAGE_SPEC.minBytes / 1024} KB minimum`);
    } else if (sizeBytes > HERO_IMAGE_SPEC.maxBytes) {
      out.push(`${Math.round(sizeBytes / 1024)} KB — above the ${HERO_IMAGE_SPEC.maxBytes / 1024} KB target`);
    }
  }
  if (mimeType && mimeType !== HERO_IMAGE_SPEC.preferredType) {
    out.push("WebP recommended");
  }
  return out;
}
