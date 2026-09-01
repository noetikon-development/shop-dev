"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { Card, notify, usePersistentAction } from "@/components/admin/ui";
import { saveNavAction } from "@/lib/admin/content-nav-actions";
import { NAV_UTILITY_LABELS, type NavActionState } from "@/lib/nav-defaults";
import type { NavData } from "@/lib/content-blocks";

export type CategoryOption = { value: string; label: string; depth: number };

const EMPTY: NavActionState = {};

type NavChild = { label: string; categorySlug: string; href: string; enabled: boolean };
type NavItem = NavChild & { children: NavChild[] };

const BLANK_CHILD: NavChild = { label: "", categorySlug: "", href: "", enabled: true };
const BLANK_ITEM: NavItem = { ...BLANK_CHILD, children: [] };

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

export function NavigationEditor({
  initial,
  fallback,
  categoryOptions,
  canManage,
}: {
  initial: NavData | null;
  fallback: NavData;
  categoryOptions: CategoryOption[];
  canManage: boolean;
}) {
  const { state, onSubmit, pending } = usePersistentAction<NavActionState>(saveNavAction, EMPTY);
  const doneRef = useRef(false);

  const [data, setData] = useState<NavData>(initial ?? fallback);

  useEffect(() => {
    if (state.ok && !doneRef.current) {
      doneRef.current = true;
      notify.success("Navigation saved");
    }
    if (state.error) doneRef.current = false;
  }, [state]);

  const items = data.items as NavItem[];
  const setItems = (next: NavItem[]) => setData((d) => ({ ...d, items: next }));
  const patchItem = (i: number, patch: Partial<NavItem>) =>
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  return (
    <Card>
      <form
        onSubmit={(e) => {
          const form = e.currentTarget;
          (form.elements.namedItem("data") as HTMLInputElement).value = JSON.stringify(data);
          onSubmit(e);
        }}
        className="space-y-8"
      >
        <input type="hidden" name="data" defaultValue="{}" />

        <Section
          title="Primary menu"
          hint="These items appear in the desktop header, the mega-menu and the mobile menu — from this one list. An item linked to a category always opens that category; you set only the label, order and visibility."
        >
          <div className="space-y-3">
            {items.map((item, i) => (
              <ItemRow
                key={i}
                item={item}
                index={i}
                count={items.length}
                categoryOptions={categoryOptions}
                canManage={canManage}
                onChange={(patch) => patchItem(i, patch)}
                onMove={(dir) => setItems(move(items, i, i + dir))}
                onRemove={() => setItems(items.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
          {canManage && items.length < 24 && (
            <button
              type="button"
              onClick={() => setItems([...items, { ...BLANK_ITEM, children: [] }])}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink"
            >
              <Plus size={13} /> Add menu item
            </button>
          )}
        </Section>

        <Section
          title="Utility links"
          hint="The small links on the right of the header bar. The destination is fixed by the app — edit the label or hide the link."
        >
          <div className="space-y-2">
            {data.utility.map((u, i) => (
              <div key={u.key} className="flex items-center gap-2">
                <span className="w-32 shrink-0 text-xs text-ink-faint">
                  {NAV_UTILITY_LABELS[u.key]}
                </span>
                <input
                  aria-label={`${NAV_UTILITY_LABELS[u.key]} label`}
                  placeholder={NAV_UTILITY_LABELS[u.key]}
                  disabled={!canManage}
                  className="field text-sm"
                  value={u.label}
                  onChange={(e) =>
                    setData((d) => ({
                      ...d,
                      utility: d.utility.map((x, idx) =>
                        idx === i ? { ...x, label: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <label className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    className="accent-ink"
                    checked={u.enabled}
                    onChange={(e) =>
                      setData((d) => ({
                        ...d,
                        utility: d.utility.map((x, idx) =>
                          idx === i ? { ...x, enabled: e.target.checked } : x,
                        ),
                      }))
                    }
                  />
                  Shown
                </label>
                <MoveButtons
                  canManage={canManage}
                  index={i}
                  count={data.utility.length}
                  onMove={(dir) =>
                    setData((d) => ({ ...d, utility: move(d.utility, i, i + dir) }))
                  }
                />
              </div>
            ))}
          </div>
        </Section>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        {canManage && (
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setData(fallback)}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
            >
              <RotateCcw size={13} /> Reset to built-in defaults
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Save navigation
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function ItemRow({
  item,
  index,
  count,
  categoryOptions,
  canManage,
  onChange,
  onMove,
  onRemove,
}: {
  item: NavItem;
  index: number;
  count: number;
  categoryOptions: CategoryOption[];
  canManage: boolean;
  onChange: (patch: Partial<NavItem>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const derived = categoryOptions.find((o) => o.value === item.categorySlug)?.label;

  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Menu item label"
          placeholder={derived ? `${derived} (category name)` : "Label"}
          disabled={!canManage}
          className="field min-w-40 flex-1 text-sm"
          value={item.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <CategorySelect
          value={item.categorySlug}
          options={categoryOptions}
          disabled={!canManage}
          onChange={(v) => onChange({ categorySlug: v })}
        />
        <label className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
          <input
            type="checkbox"
            disabled={!canManage}
            className="accent-ink"
            checked={item.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          Shown
        </label>
        <MoveButtons canManage={canManage} index={index} count={count} onMove={onMove} />
        {canManage && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove menu item"
            className="shrink-0 text-ink-faint hover:text-clay"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {!item.categorySlug && (
        <div className="mt-2">
          <input
            aria-label="Custom link destination"
            placeholder="/pages/lookbook or https://…  (used when no category is selected)"
            disabled={!canManage}
            className="field text-sm"
            value={item.href}
            onChange={(e) => onChange({ href: e.target.value })}
          />
        </div>
      )}

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
        >
          <ChevronDown size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          Sub-items{" "}
          <span className="text-ink-faint">
            {item.children.length === 0
              ? item.categorySlug
                ? "· auto from category"
                : "· none"
              : `· ${item.children.length} custom`}
          </span>
        </button>

        {open && (
          <div className="mt-2 space-y-2 border-l border-line pl-3">
            {item.children.length === 0 && (
              <p className="text-xs text-ink-faint">
                {item.categorySlug
                  ? "Leaving this empty shows the category's own sub-categories. Add items below to override them."
                  : "This item has no dropdown. Add items below to give it one."}
              </p>
            )}
            {item.children.map((child, ci) => (
              <div key={ci} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="Sub-item label"
                  placeholder={
                    categoryOptions.find((o) => o.value === child.categorySlug)?.label ?? "Label"
                  }
                  disabled={!canManage}
                  className="field min-w-32 flex-1 text-sm"
                  value={child.label}
                  onChange={(e) =>
                    onChange({
                      children: item.children.map((c, idx) =>
                        idx === ci ? { ...c, label: e.target.value } : c,
                      ),
                    })
                  }
                />
                <CategorySelect
                  value={child.categorySlug}
                  options={categoryOptions}
                  disabled={!canManage}
                  onChange={(v) =>
                    onChange({
                      children: item.children.map((c, idx) =>
                        idx === ci ? { ...c, categorySlug: v } : c,
                      ),
                    })
                  }
                />
                {!child.categorySlug && (
                  <input
                    aria-label="Sub-item link"
                    placeholder="/pages/… or https://…"
                    disabled={!canManage}
                    className="field min-w-40 flex-1 text-sm"
                    value={child.href}
                    onChange={(e) =>
                      onChange({
                        children: item.children.map((c, idx) =>
                          idx === ci ? { ...c, href: e.target.value } : c,
                        ),
                      })
                    }
                  />
                )}
                <label className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    className="accent-ink"
                    checked={child.enabled}
                    onChange={(e) =>
                      onChange({
                        children: item.children.map((c, idx) =>
                          idx === ci ? { ...c, enabled: e.target.checked } : c,
                        ),
                      })
                    }
                  />
                  Shown
                </label>
                <MoveButtons
                  canManage={canManage}
                  index={ci}
                  count={item.children.length}
                  onMove={(dir) => onChange({ children: move(item.children, ci, ci + dir) })}
                />
                {canManage && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ children: item.children.filter((_, idx) => idx !== ci) })
                    }
                    aria-label="Remove sub-item"
                    className="shrink-0 text-ink-faint hover:text-clay"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {canManage && item.children.length < 40 && (
              <button
                type="button"
                onClick={() => onChange({ children: [...item.children, { ...BLANK_CHILD }] })}
                className="inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink"
              >
                <Plus size={12} /> Add sub-item
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CategorySelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: CategoryOption[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <select
      aria-label="Category or collection"
      disabled={disabled}
      className="field w-48 shrink-0 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">— Custom link —</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.depth > 0 ? `  ${o.label}` : o.label}
        </option>
      ))}
    </select>
  );
}

function MoveButtons({
  canManage,
  index,
  count,
  onMove,
}: {
  canManage: boolean;
  index: number;
  count: number;
  onMove: (dir: -1 | 1) => void;
}) {
  if (!canManage) return null;
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label="Move up"
        className="grid h-7 w-7 place-items-center text-ink-faint hover:text-ink disabled:opacity-30"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={index === count - 1}
        aria-label="Move down"
        className="grid h-7 w-7 place-items-center text-ink-faint hover:text-ink disabled:opacity-30"
      >
        <ChevronDown size={14} />
      </button>
    </span>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint && <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
