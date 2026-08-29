import { cn } from "@/lib/utils";

/**
 * AXIARO uses an original, in-house illustration system for product imagery:
 * minimal line-drawn objects on soft tinted panels. No third-party photography.
 * Each art "kind" maps to a category; the tint is chosen deterministically from a seed
 * so a product looks consistent everywhere it appears.
 */

export type ArtKind =
  | "sofa"
  | "chair"
  | "table"
  | "storage"
  | "bed"
  | "lighting"
  | "kitchen"
  | "tableware"
  | "textile"
  | "decor"
  | "rug"
  | "plant"
  | "apparel-top"
  | "apparel-dress"
  | "outerwear"
  | "bag"
  | "footwear"
  | "accessory";

const PANELS: { bg: string; ink: string }[] = [
  { bg: "#efe9df", ink: "#2b2622" },
  { bg: "#e7ece6", ink: "#26302a" },
  { bg: "#efe6e2", ink: "#37271f" },
  { bg: "#e8e9ec", ink: "#242730" },
  { bg: "#f0ebe1", ink: "#33302a" },
  { bg: "#e9e4ec", ink: "#2d2733" },
];

export function panelForSeed(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PANELS[h % PANELS.length];
}

function Drawing({ kind, stroke }: { kind: ArtKind; stroke: string }) {
  const s = {
    stroke,
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const soft = { ...s, opacity: 0.45 };

  switch (kind) {
    case "sofa":
      return (
        <g {...s}>
          <path d="M60 118 h180 v46 a10 10 0 0 1 -10 10 h-8 v14 h-18 v-14 H114 v14 H96 v-14 h-8 a10 10 0 0 1 -10 -10 z" />
          <path d="M78 118 v-30 a14 14 0 0 1 14 -14 h116 a14 14 0 0 1 14 14 v30" />
          <path d="M96 118 c0 -22 12 -30 30 -30 h48 c18 0 30 8 30 30" {...soft} />
        </g>
      );
    case "chair":
      return (
        <g {...s}>
          <path d="M112 60 h76 v96 h-76 z" />
          <path d="M112 156 l-16 74 M188 156 l16 74 M120 200 h60" />
          <path d="M126 78 h48 M126 96 h48" {...soft} />
        </g>
      );
    case "table":
      return (
        <g {...s}>
          <path d="M64 108 h172 M74 108 v92 M226 108 v92 M74 150 h152" />
          <path d="M64 108 l24 -18 h124 l24 18" {...soft} />
        </g>
      );
    case "storage":
      return (
        <g {...s}>
          <rect x="78" y="60" width="144" height="180" rx="6" />
          <path d="M150 60 v180 M78 120 h144 M78 180 h144" />
          <circle cx="134" cy="150" r="3.4" fill={stroke} />
          <circle cx="166" cy="150" r="3.4" fill={stroke} />
        </g>
      );
    case "bed":
      return (
        <g {...s}>
          <path d="M56 150 h188 v56 h-188 z" />
          <path d="M56 150 v-52 a10 10 0 0 1 10 -10 h20 a10 10 0 0 1 10 10 v34" />
          <path d="M244 150 v-34" />
          <path d="M76 128 h150 v22 h-150 z" {...soft} />
          <path d="M56 206 v20 M244 206 v20" />
        </g>
      );
    case "lighting":
      return (
        <g {...s}>
          <path d="M150 40 v40" />
          <path d="M112 80 h76 l-14 44 h-48 z" />
          <path d="M150 124 v92 M126 216 h48" />
          <path d="M120 100 h60" {...soft} />
        </g>
      );
    case "kitchen":
      return (
        <g {...s}>
          <path d="M96 120 a54 54 0 0 0 108 0 z" />
          <path d="M150 120 v-56 a16 16 0 0 1 32 0" />
          <path d="M120 174 l-8 46 h76 l-8 -46" />
        </g>
      );
    case "tableware":
      return (
        <g {...s}>
          <circle cx="150" cy="150" r="70" />
          <circle cx="150" cy="150" r="44" {...soft} />
        </g>
      );
    case "textile":
      return (
        <g {...s}>
          <path d="M92 74 h116 v152 h-116 z" />
          <path d="M92 100 q29 14 58 0 t58 0 M92 150 q29 14 58 0 t58 0 M92 200 q29 14 58 0 t58 0" {...soft} />
        </g>
      );
    case "rug":
      return (
        <g {...s}>
          <path d="M70 96 l160 0 l0 108 l-160 0 z" transform="skewX(-8)" />
          <path d="M96 116 h120 M92 150 h128 M96 184 h120" {...soft} />
        </g>
      );
    case "decor":
      return (
        <g {...s}>
          <path d="M126 96 q-18 40 0 72 a24 24 0 0 0 48 0 q18 -32 0 -72 z" />
          <path d="M132 96 q18 -18 36 0" />
        </g>
      );
    case "plant":
      return (
        <g {...s}>
          <path d="M122 150 h56 l-8 74 h-40 z" />
          <path d="M150 150 c-4 -34 -20 -50 -44 -54 c2 30 16 50 44 54 z" />
          <path d="M150 150 c4 -40 22 -58 48 -62 c-2 34 -18 56 -48 62 z" />
          <path d="M150 150 v-70" {...soft} />
        </g>
      );
    case "apparel-top":
      return (
        <g {...s}>
          <path d="M112 74 l-34 24 l16 26 l18 -10 v96 h116 v-96 l18 10 l16 -26 l-34 -24 a34 34 0 0 1 -116 0 z" />
        </g>
      );
    case "apparel-dress":
      return (
        <g {...s}>
          <path d="M120 70 l-24 20 l12 20 l12 -6 M180 70 l24 20 l-12 20 l-12 -6" />
          <path d="M120 70 h60 l24 150 h-108 z" />
          <path d="M132 120 h36" {...soft} />
        </g>
      );
    case "outerwear":
      return (
        <g {...s}>
          <path d="M110 72 l-30 22 v34 l16 -8 v104 h128 v-104 l16 8 v-34 l-30 -22 z" />
          <path d="M150 74 v142" />
          <circle cx="150" cy="130" r="3" fill={stroke} />
          <circle cx="150" cy="160" r="3" fill={stroke} />
        </g>
      );
    case "bag":
      return (
        <g {...s}>
          <path d="M92 116 h116 l10 108 h-136 z" />
          <path d="M118 116 v-14 a32 32 0 0 1 64 0 v14" />
        </g>
      );
    case "footwear":
      return (
        <g {...s}>
          <path d="M74 176 c22 4 44 -2 66 -20 c14 -12 30 -16 54 -12 c22 4 34 16 34 30 c0 10 -8 16 -22 16 h-124 c-8 0 -12 -6 -8 -14 z" />
          <path d="M120 150 l10 14 M140 138 l10 14" {...soft} />
        </g>
      );
    case "accessory":
      return (
        <g {...s}>
          <circle cx="150" cy="150" r="58" />
          <path d="M150 92 v-16 M150 224 v16 M92 150 h-16 M224 150 h16" {...soft} />
        </g>
      );
    default:
      return (
        <g {...s}>
          <rect x="90" y="90" width="120" height="120" rx="10" />
        </g>
      );
  }
}

export function ProductArt({
  kind,
  seed,
  className,
  priority: _priority,
}: {
  kind: ArtKind;
  seed: string;
  className?: string;
  priority?: boolean;
}) {
  const panel = panelForSeed(seed);
  return (
    <svg
      viewBox="0 0 300 300"
      role="img"
      aria-hidden="true"
      className={cn("h-full w-full", className)}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="300" height="300" fill={panel.bg} />
      <circle cx="150" cy="140" r="118" fill="#ffffff" opacity="0.35" />
      <Drawing kind={kind} stroke={panel.ink} />
    </svg>
  );
}
