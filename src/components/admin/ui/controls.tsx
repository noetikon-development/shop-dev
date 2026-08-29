"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * URL-driven table controls (search / filter / pagination) + form
 * primitives. All reusable; none are wired to a specific section.
 * ------------------------------------------------------------------ */

function useQueryParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // any filter/search change resets pagination
      if (!("page" in updates)) next.delete("page");
      start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [params, pathname, router],
  );

  return { params, setParam, pending };
}

// --- SearchInput ------------------------------------------------
export function SearchInput({
  placeholder = "Search…",
  paramKey = "q",
  debounceMs = 350,
}: {
  placeholder?: string;
  paramKey?: string;
  debounceMs?: number;
}) {
  const { params, setParam, pending } = useQueryParam();
  const [value, setValue] = useState(params.get(paramKey) ?? "");

  useEffect(() => {
    const id = setTimeout(() => {
      if (value !== (params.get(paramKey) ?? "")) setParam({ [paramKey]: value || null });
    }, debounceMs);
    return () => clearTimeout(id);
  }, [value, debounceMs, paramKey, params, setParam]);

  return (
    <div className="relative w-full max-w-xs">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="field py-2 pl-9 pr-8 text-sm"
      />
      {pending ? (
        <Loader2
          size={14}
          className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-ink-faint"
        />
      ) : (
        value && (
          <button
            type="button"
            onClick={() => setValue("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
          >
            <X size={14} />
          </button>
        )
      )}
    </div>
  );
}

// --- FilterSelect (URL-bound) --------------------------------
export function FilterSelect({
  label,
  paramKey,
  options,
  allLabel = "All",
}: {
  label: string;
  paramKey: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const { params, setParam } = useQueryParam();
  const current = params.get(paramKey) ?? "";
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-faint">{label}</span>
      <select
        value={current}
        onChange={(e) => setParam({ [paramKey]: e.target.value || null })}
        className="field w-auto py-1.5 pr-8 text-sm"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface p-3">
      {children}
    </div>
  );
}

// --- Pagination (URL-bound) ---------------------------------
export function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const { setParam, pending } = useQueryParam();
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-ink-faint">
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1 || pending}
          onClick={() => setParam({ page: String(page - 1) })}
          className="btn btn-outline p-2 disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          disabled={page >= totalPages || pending}
          onClick={() => setParam({ page: String(page + 1) })}
          className="btn btn-outline p-2 disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

// --- FormField ----------------------------------------------
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="ml-0.5 text-clay">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-clay">{error}</p>
      ) : (
        hint && <p className="text-xs text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

// --- Select (styled) --------------------------------------
export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cn("field pr-9 text-sm", className)} {...props}>
      {children}
    </select>
  );
}
