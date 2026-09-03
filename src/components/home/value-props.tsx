import { Truck, RotateCcw, Compass, Headset } from "lucide-react";

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
  { icon: Compass, title: "Discover more for everyday living", copy: "Find useful products for every part of life." },
  { icon: Headset, title: "Helpful support", copy: "We're here to help before, during, and after your purchase." },
];

export function ValueProps() {
  return (
    <section>
      <div className="container-page grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
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
