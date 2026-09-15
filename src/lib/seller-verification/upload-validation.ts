import "server-only";
import { sniffMimeType } from "@/lib/admin/media";
import { MAX_MEDIA_BYTES } from "@/lib/media-constants";

/**
 * Seller Verification — upload validation (Phase 3).
 *
 * Reuses `src/lib/admin/media.ts`'s magic-byte sniffing (the same proven
 * approach: detect the REAL content type from file bytes, never trust the
 * browser-supplied `file.type`) and the project's existing 8 MB cap
 * (`MAX_MEDIA_BYTES`) — no new size policy invented for this domain. The
 * allow-list here is narrower than the admin media library's (no GIF): a
 * verification document is a scan/photo of an ID or a PDF, never an
 * animated image. SVG is never accepted — it is XML text, so
 * `sniffMimeType` never recognizes it as a match, and it is rejected the
 * same way any other unrecognized content is: as "unsupported".
 *
 * KNOWN LIMITATION (documented, not solved here): there is no malware/virus
 * scanning anywhere in this application, for the admin media library or for
 * this upload path. This phase does not invent one. The mitigations in
 * place are the ones already used elsewhere in the app: a strict allow-list,
 * real magic-byte validation (not the declared MIME type), a hard size cap,
 * and — specific to this domain — private storage with no public URL and no
 * anonymous read access, so even an uploaded malicious file is never
 * reachable by an unauthenticated third party.
 */

export const SELLER_VERIFICATION_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
export type SellerVerificationMimeType = (typeof SELLER_VERIFICATION_ALLOWED_TYPES)[number];

export const SELLER_VERIFICATION_MAX_BYTES = MAX_MEDIA_BYTES;

const EXTENSION_FOR_MIME: Record<SellerVerificationMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export type SellerVerificationUploadValidation =
  | { ok: true; mimeType: SellerVerificationMimeType; extension: string }
  | { ok: false; error: string };

/**
 * Validate a candidate upload's SIZE and CONTENT (never its declared type
 * alone). `declaredType` is the browser's `file.type` — used only as a
 * sanity cross-check against the sniffed type, never as the source of truth.
 */
export function validateSellerVerificationUpload(
  buffer: Buffer,
  sizeBytes: number,
  declaredType: string,
): SellerVerificationUploadValidation {
  if (sizeBytes <= 0) return { ok: false, error: "Choose a file to upload." };
  if (sizeBytes > SELLER_VERIFICATION_MAX_BYTES) {
    return { ok: false, error: `File is too large (max ${SELLER_VERIFICATION_MAX_BYTES / 1024 / 1024} MB).` };
  }

  const sniffed = sniffMimeType(buffer);
  if (!sniffed || !(SELLER_VERIFICATION_ALLOWED_TYPES as readonly string[]).includes(sniffed)) {
    return { ok: false, error: "Unsupported file. Upload a PNG, JPG, WEBP or PDF." };
  }
  // The browser's declared type must at least agree with the sniffed one —
  // catches a mislabeled or spoofed upload before it ever reaches storage.
  if (declaredType && declaredType !== sniffed && !(declaredType === "image/jpg" && sniffed === "image/jpeg")) {
    return { ok: false, error: "The file's contents don't match its type." };
  }

  const mimeType = sniffed as SellerVerificationMimeType;
  return { ok: true, mimeType, extension: EXTENSION_FOR_MIME[mimeType] };
}

/**
 * A random, content-derived storage key — NEVER the original filename (that
 * could carry path-traversal characters or collide/leak information), never
 * anything client-supplied. Scoped under the seller and verification case's
 * own server-derived ids, so the resulting path can only ever land inside
 * that seller's own subtree.
 */
export function buildSellerVerificationStoragePath(
  sellerId: string,
  verificationId: string,
  extension: string,
): string {
  const randomId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `sellers/${sellerId}/verification/${verificationId}/${randomId}${extension}`;
}
