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
