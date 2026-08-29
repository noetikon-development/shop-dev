"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUp, ArrowDown, Loader2 } from "lucide-react";
import { StatusBadge, notify } from "@/components/admin/ui";
import { reorderCategories, setCategoryActive, type CatalogState } from "@/lib/admin/catalog-actions";

type Cat = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  featured: boolean;
  sortOrder: number;
  parentName: string | null;
  productCount: number;
  childCount: number;
};

export function CategoryList({ categories, canEdit }: { categories: Cat[]; canEdit: boolean }) {
  const router = useRouter();
  const [order, setOrder] = useState(categories);
  const [reorderState, reorderAction, saving] = useActionState<CatalogState, FormData>(
    reorderCategories,
    {},
  );

  const serverKey = categories.map((c) => `${c.id}:${c.sortOrder}:${c.active}`).join(",");
  const [lastKey, setLastKey] = useState(serverKey);
  if (lastKey !== serverKey) {
    setLastKey(serverKey);
    setOrder(categories);
  }

  useEffect(() => {
    if (reorderState.ok) {
      notify.success(reorderState.message ?? "Order saved");
      router.refresh();
    }
    if (reorderState.error) notify.error(reorderState.error);
  }, [reorderState, router]);

  const move = (index: number, dir: -1 | 1) => {
    const next = [...order];
    const t = index + dir;
    if (t < 0 || t >= next.length) return;
    [next[index], next[t]] = [next[t], next[index]];
    setOrder(next);
  };

  const dirty = order.map((c) => c.id).join(",") !== categories.map((c) => c.id).join(",");

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
              {canEdit && <th className="px-3 py-2 font-semibold">Order</th>}
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 font-semibold">Parent</th>
              <th className="px-3 py-2 font-semibold">Products</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              {canEdit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {order.map((c, i) => (
              <tr key={c.id} className="border-b border-line/60 last:border-0">
                {canEdit && (
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="btn btn-ghost p-1 disabled:opacity-30"
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === order.length - 1}
                      aria-label="Move down"
                      className="btn btn-ghost p-1 disabled:opacity-30"
                    >
                      <ArrowDown size={14} />
                    </button>
                  </td>
                )}
                <td className="px-3 py-2.5">
                  <Link href={`/admin/categories/${c.id}`} className="font-medium text-ink hover:underline">
                    {c.name}
                  </Link>
                  <p className="text-xs text-ink-faint">/{c.slug}</p>
                </td>
                <td className="px-3 py-2 text-ink-soft">{c.parentName ?? "—"}</td>
                <td className="px-3 py-2 text-ink-soft">
                  {c.productCount}
                  {c.childCount > 0 && (
                    <span className="ml-1 text-xs text-ink-faint">· {c.childCount} sub</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5">
                    <StatusBadge tone={c.active ? "success" : "neutral"}>
                      {c.active ? "Active" : "Inactive"}
                    </StatusBadge>
                    {c.featured && <StatusBadge tone="info">Featured</StatusBadge>}
                  </span>
                </td>
                {canEdit && (
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <ToggleActive id={c.id} active={c.active} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && dirty && (
        <form action={reorderAction} className="flex items-center gap-3">
          {order.map((c, i) => (
            <input key={c.id} type="hidden" name="order" value={`${c.id}:${i}`} />
          ))}
          <button type="submit" disabled={saving} className="btn btn-primary py-2 text-sm">
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save order
          </button>
          <button type="button" onClick={() => setOrder(categories)} className="btn btn-outline py-2 text-sm">
            Reset
          </button>
        </form>
      )}
    </div>
  );
}

function ToggleActive({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<CatalogState, FormData>(setCategoryActive, {});
  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Updated");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "" : "on"} />
      <button type="submit" disabled={pending} className="btn btn-outline py-1.5 text-xs">
        {pending && <Loader2 size={12} className="animate-spin" />}
        {active ? "Deactivate" : "Activate"}
      </button>
    </form>
  );
}
