import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EmptyState, LoadingState } from "@/components/admin/ui/primitives";

/* ------------------------------------------------------------------ *
 * Generic, reusable table. Server-compatible (no hooks). Interactive
 * behaviour (sorting, selection) is layered on by callers in later
 * steps — this is the presentational foundation.
 * ------------------------------------------------------------------ */

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Cell renderer. Defaults to `String(row[key])`. */
  cell?: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  align?: "left" | "right" | "center";
};

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  isLoading,
  empty,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  isLoading?: boolean;
  empty?: { title: string; description?: string; icon?: ReactNode; action?: ReactNode };
  caption?: string;
}) {
  if (isLoading) return <LoadingState rows={5} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        title={empty?.title ?? "Nothing here yet"}
        description={empty?.description}
        icon={empty?.icon}
        action={empty?.action}
      />
    );
  }

  const alignClass = (a?: "left" | "right" | "center") =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-surface-sunken/60">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-faint",
                  alignClass(col.align),
                  col.headerClassName,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={getRowKey(row, i)}
              className="border-b border-line/60 last:border-0 hover:bg-surface-sunken/40"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-4 py-3 text-ink-soft",
                    alignClass(col.align),
                    col.className,
                  )}
                >
                  {col.cell
                    ? col.cell(row)
                    : String((row as Record<string, unknown>)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
