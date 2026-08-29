import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * Rendered (with a real HTTP 403) whenever `forbidden()` is thrown — e.g. a
 * signed-in customer who tries to open the admin area, or an admin who lacks the
 * permission for a section.
 */
export default function Forbidden() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <Logo className="h-12" />
      <p className="eyebrow mt-10">Error 403</p>
      <h1 className="mt-3 text-4xl">You don’t have access to this page</h1>
      <p className="mt-3 max-w-md text-ink-soft">
        Your account isn’t authorized to view this resource. If you think this is a
        mistake, contact a Super Admin.
      </p>
      <div className="mt-7 flex gap-3">
        <Link href="/" className="btn btn-primary">
          Back to store
        </Link>
        <Link href="/admin/login" className="btn btn-outline">
          Admin sign in
        </Link>
      </div>
    </div>
  );
}
