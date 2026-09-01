import { Truck, RotateCcw, Sparkles, Wrench } from "lucide-react";

/**
 * Built-in value-props row — the structural fallback rendered by `page.tsx`
 * only when NO homepage ContentBlocks are published. The wording is kept
 * evergreen and free of specific figures (thresholds, fees, return windows):
 * those live in Store Settings / the CMS `value_props` block. Safety net, not
 * a content source.
 */
const PROPS = [
  { icon: Truck, title: "Free standard shipping", copy: "On qualifying orders. Express delivery available." },
  { icon: RotateCcw, title: "Easy returns", copy: "Changed your mind? Send it back, no fuss." },
  { icon: Sparkles, title: "Considered, in-house design", copy: "Drawn, specced and refined by our own team." },
  { icon: Wrench, title: "Assembly help", copy: "Clear instructions, and a hand if you want one." },
];

export function ValueProps() {
  return (
    <section className="border-y border-line bg-surface">
      <div className="container-page grid gap-x-8 gap-y-6 py-10 sm:grid-cols-2 lg:grid-cols-4">
        {PROPS.map((p) => (
          <div key={p.title} className="flex gap-3.5">
            <p.icon size={22} strokeWidth={1.5} className="mt-0.5 shrink-0 text-clay" />
            <div>
              <p className="text-body font-medium">{p.title}</p>
              <p className="mt-1 text-meta text-ink-faint">{p.copy}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
