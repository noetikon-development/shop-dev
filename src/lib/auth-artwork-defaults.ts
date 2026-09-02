import type { AuthArtworkData } from "@/lib/content-blocks";

/** The single authentication-artwork ContentBlock (`area:"global"`). */
export const AUTH_ARTWORK_BLOCK_KEY = "auth.artwork";

export type AuthArtworkActionState = { ok?: boolean; error?: string };

/**
 * Built-in default: no image, disabled. The auth layout renders its in-house
 * `ProductArt` sofa illustration in this state, so the artwork is never blank.
 * Also used by the admin editor as the "reset" starting point. Pure data — safe
 * to import anywhere.
 */
export const AUTH_ARTWORK_DEFAULTS: AuthArtworkData = {
  imageMediaId: "",
  alt: "",
  enabled: false,
};
