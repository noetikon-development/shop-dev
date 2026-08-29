import { Truck, RotateCcw, ShieldCheck, Wrench } from "lucide-react";

const PROPS = [
  { icon: Truck, title: "Free shipping over ₱2,500", copy: "Flat ₱129 below that. Express available." },
  { icon: RotateCcw, title: "30-day returns", copy: "Changed your mind? Send it back, no fuss." },
  { icon: ShieldCheck, title: "10-year guarantee", copy: "On the frame of every piece of furniture." },
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
              <p className="text-sm font-medium">{p.title}</p>
              <p className="mt-1 text-xs text-ink-faint">{p.copy}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
