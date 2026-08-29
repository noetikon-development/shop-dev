import { Stars } from "@/components/ui/primitives";
import { formatDate } from "@/lib/utils";
import type { ReviewView } from "@/lib/types";

export function Reviews({
  reviews,
  ratingAvg,
  ratingCount,
}: {
  reviews: ReviewView[];
  ratingAvg: number;
  ratingCount: number;
}) {
  const buckets = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviews.filter((r) => Math.round(r.rating) === star).length,
  }));
  const shownTotal = reviews.length || 1;

  return (
    <section id="reviews" className="scroll-mt-28">
      <h2 className="text-2xl">Reviews</h2>

      <div className="mt-6 grid gap-8 sm:grid-cols-[220px_1fr] sm:gap-12">
        <div>
          <div className="flex items-end gap-2">
            <span className="font-display text-5xl">{ratingAvg.toFixed(1)}</span>
            <span className="pb-1.5 text-sm text-ink-faint">/ 5</span>
          </div>
          <Stars value={ratingAvg} showNumber={false} className="mt-2" />
          <p className="mt-2 text-sm text-ink-faint">
            Based on {ratingCount.toLocaleString()} ratings
          </p>

          <div className="mt-5 space-y-1.5">
            {buckets.map((b) => (
              <div key={b.star} className="flex items-center gap-2 text-xs text-ink-faint">
                <span className="w-3 tabular-nums">{b.star}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-clay"
                    style={{ width: `${(b.count / shownTotal) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-right tabular-nums">{b.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          {reviews.length === 0 ? (
            <p className="text-sm text-ink-soft">No written reviews yet.</p>
          ) : (
            <ul className="space-y-6">
              {reviews.map((r) => (
                <li key={r.id} className="border-b border-line pb-6 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <Stars value={r.rating} showNumber={false} size={13} />
                    <span className="text-xs text-ink-faint">{formatDate(r.createdAt)}</span>
                  </div>
                  {r.title && <p className="mt-2 text-sm font-medium">{r.title}</p>}
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{r.body}</p>
                  <p className="mt-2 text-xs text-ink-faint">
                    {r.author}
                    {r.verified && <span className="text-success"> · Verified purchase</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
