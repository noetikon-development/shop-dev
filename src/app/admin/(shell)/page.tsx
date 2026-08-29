import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/admin/rbac";
import { PERMISSIONS, PERMISSION_GROUPS } from "@/lib/rbac/catalog";
import { ADMIN_SECTIONS, sectionVisibleFor } from "@/lib/admin/sections";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminDashboard() {
  const admin = await requirePermission("view_dashboard");

  const grantedByGroup = PERMISSION_GROUPS.map((group) => ({
    group,
    perms: PERMISSIONS.filter(
      (p) => p.group === group && (admin.isSuperAdmin || admin.permissions.has(p.key)),
    ),
  })).filter((g) => g.perms.length > 0);

  const quickLinks = ADMIN_SECTIONS.filter(
    (s) => s.slug && (admin.isSuperAdmin || sectionVisibleFor(s, admin.permissions)),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-1 text-3xl">Welcome, {admin.user.name?.split(" ")[0] ?? "there"}</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          Signed in as {admin.user.email}. This is a foundation build — management
          screens arrive in the next step.
        </p>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="card-surface p-5">
          <p className="eyebrow">Your roles</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {admin.roles.map((r) => (
              <span
                key={r}
                className="rounded-xs bg-ink px-2 py-1 text-xs font-medium uppercase tracking-wide text-paper"
              >
                {r.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>
        <div className="card-surface p-5">
          <p className="eyebrow">Access</p>
          <p className="mt-2 text-sm text-ink-soft">
            {admin.isSuperAdmin
              ? "Full access to every permission."
              : `${admin.permissions.size} permission${admin.permissions.size === 1 ? "" : "s"} across ${grantedByGroup.length} area${grantedByGroup.length === 1 ? "" : "s"}.`}
          </p>
        </div>
      </section>

      {quickLinks.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg">Sections you can open</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {quickLinks.map((s) => (
              <Link
                key={s.slug}
                href={`/admin/${s.slug}`}
                className="rounded-sm border border-line-strong px-3 py-2 text-sm transition-colors hover:border-ink hover:bg-surface"
              >
                {s.label}
                {!s.live && <span className="ml-1.5 text-xs text-ink-faint">soon</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg">Your permissions</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {grantedByGroup.map(({ group, perms }) => (
            <div key={group} className="card-surface p-4">
              <p className="text-sm font-medium">{group}</p>
              <ul className="mt-1.5 space-y-1">
                {perms.map((p) => (
                  <li key={p.key} className="text-xs text-ink-soft">
                    <code className="text-ink">{p.key}</code> — {p.description}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
