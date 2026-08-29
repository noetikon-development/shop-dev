"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Reflects auth state changes that happen outside a server action — e.g. the
 * session being revoked, or a sign-in/out in another tab. Server actions do
 * their own redirect + revalidate, so those events are ignored here to avoid
 * racing the action's Set-Cookie response.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const ready = useRef(false);

  useEffect(() => {
    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // Skip the initial event fired on mount.
      if (!ready.current) {
        ready.current = true;
        return;
      }
      if (event === "SIGNED_OUT") router.refresh();
    });
    return () => subscription.unsubscribe();
  }, [router]);

  return <>{children}</>;
}
