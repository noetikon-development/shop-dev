import { requireUser } from "@/lib/auth";
import { AccountNav } from "@/components/account/account-nav";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function AccountLayout({ children }: LayoutProps<"/account">) {
  const user = await requireUser("/account");

  return (
    <div className="container-page py-8 sm:py-12">
      <PageHeader title="My account" description={`Signed in as ${user.name ?? user.email}`} />

      <div className="grid gap-10 lg:grid-cols-[200px_1fr]">
        <aside className="lg:sticky lg:top-28 lg:h-fit">
          <AccountNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
