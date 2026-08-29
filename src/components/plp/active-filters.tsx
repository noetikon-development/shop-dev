"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { buildQuery } from "@/lib/listing-params";

export function ActiveFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const chips: { label: string; clear: Record<string, null | string> }[] = [];

  if (sp.get("q")) chips.push({ label: `“${sp.get("q")}”`, clear: { q: null } });
  if (sp.get("min")) chips.push({ label: `Min ₱${sp.get("min")}`, clear: { min: null } });
  if (sp.get("max")) chips.push({ label: `Max ₱${sp.get("max")}`, clear: { max: null } });
  for (const c of (sp.get("color") ?? "").split(",").filter(Boolean)) {
    const rest = (sp.get("color") ?? "").split(",").filter((x) => x && x !== c);
    chips.push({ label: c, clear: { color: rest.join(",") || null } });
  }
  if (sp.get("rating")) chips.push({ label: `${sp.get("rating")}★ & up`, clear: { rating: null } });
  if (sp.get("sale") === "1") chips.push({ label: "On sale", clear: { sale: null } });
  if (sp.get("stock") === "1") chips.push({ label: "In stock", clear: { stock: null } });
  if (sp.get("ship") === "1") chips.push({ label: "Free shipping", clear: { ship: null } });

  if (!chips.length) return null;

  const go = (patch: Record<string, null | string>) =>
    router.push(`${pathname}${buildQuery(new URLSearchParams(sp.toString()), patch)}`, {
      scroll: false,
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip, i) => (
        <button
          key={i}
          onClick={() => go(chip.clear)}
          className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs text-ink-soft hover:text-ink"
        >
          {chip.label}
          <X size={12} />
        </button>
      ))}
      <button
        onClick={() =>
          go({ q: null, min: null, max: null, color: null, rating: null, sale: null, stock: null, ship: null })
        }
        className="text-xs font-medium text-ink underline underline-offset-2"
      >
        Clear all
      </button>
    </div>
  );
}
