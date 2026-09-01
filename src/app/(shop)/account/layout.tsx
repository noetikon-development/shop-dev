import { requireUser } from "@/lib/auth";
import { AccountNav } from "@/components/account/account-nav";

export const dynamic = "force-dynamic";

export default async function AccountLayout({ children }: LayoutProps<"/account">) {
  const user = await requireUser("/account");

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="text-3xl sm:text-display">My account</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          Signed in as {user.name ?? user.email}
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-[200px_1fr]">
        <aside className="lg:sticky lg:top-28 lg:h-fit">
          <AccountNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
