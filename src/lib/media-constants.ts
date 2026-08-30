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
 * Recommended image standards. These are ADVISORY — they produce warnings in
 * the admin, never a hard block. "Quality 82–85" is a production recommendation
 * for the person exporting the file; it is not an attribute the server can read
 * back from an encoded image, so it is not checked here.
 */
export type ImageSpec = {
  label: string;
  width: number;
  height: number;
  /** width/height ratio the image should match (e.g. 1 for square, 4/3). */
  ratio: number;
  minBytes: number;
  maxBytes: number;
  preferredType: string;
  /** One-line human recommendation shown in the picker. */
  recommendation: string;
};

export const HERO_IMAGE_SPEC: ImageSpec = {
  label: "Hero panel",
  width: 1600,
  height: 1600,
  ratio: 1,
  minBytes: 150 * 1024,
  maxBytes: 500 * 1024,
  preferredType: "image/webp",
  recommendation: "1600×1600px, 1:1, sRGB, WebP, quality 82–85, 150–500 KB",
};

export const CATEGORY_IMAGE_SPEC: ImageSpec = {
  label: "Category",
  width: 1600,
  height: 1200,
  ratio: 4 / 3,
  minBytes: 150 * 1024,
  maxBytes: 500 * 1024,
  preferredType: "image/webp",
  recommendation: "1600×1200px, 4:3, sRGB, WebP, quality 82–85, 150–500 KB",
};

export type ImageSpecWarning = string;

/**
 * Compare an image's known metadata against an ImageSpec. Returns a list of
 * human-readable advisory warnings (empty = within spec, or not enough info to
 * judge). width/height may be null for assets uploaded before dimensions were
 * captured — those produce no dimension warning.
 */
export function imageSpecWarnings(
  meta: {
    width?: number | null;
    height?: number | null;
    sizeBytes?: number | null;
    mimeType?: string | null;
  },
  spec: ImageSpec = HERO_IMAGE_SPEC,
): ImageSpecWarning[] {
  const out: ImageSpecWarning[] = [];
  const { width, height, sizeBytes, mimeType } = meta;

  if (typeof width === "number" && typeof height === "number" && height > 0) {
    const ratio = width / height;
    if (Math.abs(ratio - spec.ratio) > 0.02) {
      out.push(`${width}×${height} — recommended ${spec.width}×${spec.height} (${ratioLabel(spec.ratio)})`);
    } else if (width !== spec.width || height !== spec.height) {
      out.push(`${width}×${height} — recommended ${spec.width}×${spec.height}`);
    }
  }
  if (typeof sizeBytes === "number") {
    if (sizeBytes < spec.minBytes) {
      out.push(`${Math.round(sizeBytes / 1024)} KB — below the ${spec.minBytes / 1024} KB minimum`);
    } else if (sizeBytes > spec.maxBytes) {
      out.push(`${Math.round(sizeBytes / 1024)} KB — above the ${spec.maxBytes / 1024} KB target`);
    }
  }
  if (mimeType && mimeType !== spec.preferredType) {
    out.push("WebP recommended");
  }
  return out;
}

function ratioLabel(ratio: number): string {
  if (Math.abs(ratio - 1) < 0.02) return "1:1";
  if (Math.abs(ratio - 4 / 3) < 0.02) return "4:3";
  if (Math.abs(ratio - 16 / 9) < 0.02) return "16:9";
  if (Math.abs(ratio - 3 / 2) < 0.02) return "3:2";
  return ratio.toFixed(2);
}

/** @deprecated use `imageSpecWarnings(meta, HERO_IMAGE_SPEC)`. */
export const heroImageWarnings = (meta: Parameters<typeof imageSpecWarnings>[0]) =>
  imageSpecWarnings(meta, HERO_IMAGE_SPEC);
