"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared open/close behaviour for popovers and dropdowns (Phase 5D Stage 2).
 *
 * Provides: open state, an Escape-to-close handler that returns focus to the
 * trigger, and outside-pointer-down dismissal. Attach `triggerRef` to the
 * button and `contentRef` to the floating panel.
 *
 * This is additive — it does not change how a menu opens; it adds the
 * keyboard + click-away affordances that the hand-rolled dropdowns lack.
 */
export function useDisclosure<
  T extends HTMLElement = HTMLElement,
  C extends HTMLElement = HTMLElement,
>(options: { onClose?: () => void } = {}) {
  const { onClose } = options;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<T | null>(null);
  const contentRef = useRef<C | null>(null);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen((wasOpen) => {
        if (wasOpen) onClose?.();
        return false;
      });
      if (returnFocus) triggerRef.current?.focus();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !contentRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        close(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  return { open, setOpen, toggle: () => setOpen((v) => !v), close, triggerRef, contentRef };
}
