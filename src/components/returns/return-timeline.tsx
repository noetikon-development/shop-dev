import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A compact vertical stepper for a return's progress. Pure — derived from the
 * status alone. REJECTED / CANCELLED are shown as a terminal note by the caller.
 */

const HAPPY_PATH = [
  { key: "REQUESTED", label: "Requested" },
  { key: "APPROVED", label: "Approved" },
  { key: "RECEIVED", label: "Items received" },
  { key: "REFUND_INITIATED", label: "Refund initiated" },
  { key: "REFUND_COMPLETED", label: "Refund completed" },
] as const;

export function ReturnTimeline({ status }: { status: string }) {
  const terminalOffPath = status === "REJECTED" || status === "CANCELLED";
  const currentIndex = terminalOffPath
    ? -1
    : HAPPY_PATH.findIndex((s) => s.key === status);

  return (
    <ol className="space-y-3">
      {HAPPY_PATH.map((step, i) => {
        const done = !terminalOffPath && i < currentIndex;
        const current = !terminalOffPath && i === currentIndex;
        return (
          <li key={step.key} className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
                done && "border-sage bg-sage text-white",
                current && "border-ink bg-ink text-paper",
                !done && !current && "border-line text-ink-faint",
              )}
            >
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span
              className={cn(
                "text-sm",
                current ? "font-medium text-ink" : done ? "text-ink-soft" : "text-ink-faint",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
