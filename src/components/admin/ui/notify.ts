"use client";

import { toast } from "sonner";

/**
 * Thin wrapper over `sonner` so every admin section notifies consistently and
 * we have one place to restyle later. Use for success + error feedback after
 * mutations; use <ConfirmDialog> for destructive confirmation.
 */
export const notify = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  info: (message: string) => toast(message),
  promise: toast.promise,
};
