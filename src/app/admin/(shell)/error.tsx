"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/admin/ui";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-10">
      <ErrorState
        title="This section failed to load"
        description="An unexpected error occurred. You can retry, or head back to the dashboard."
        retry={
          <button type="button" onClick={reset} className="btn btn-primary py-2 text-sm">
            Try again
          </button>
        }
      />
    </div>
  );
}
