"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { SORT_OPTIONS } from "@/lib/constants";
import { buildQuery } from "@/lib/listing-params";

export function SortSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const value = sp.get("sort") ?? "relevance";

  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Sort products</span>
      <select
        value={value}
        onChange={(e) => {
          const qs = buildQuery(
            new URLSearchParams(sp.toString()),
            { sort: e.target.value === "relevance" ? null : e.target.value },
          );
          router.push(`${pathname}${qs}`, { scroll: false });
        }}
        className="appearance-none rounded-sm border border-line-strong bg-surface py-2 pl-3 pr-9 text-sm outline-none focus:border-ink"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            Sort: {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 text-ink-faint"
      />
    </label>
  );
}
