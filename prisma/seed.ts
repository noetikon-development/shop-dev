import { PrismaClient } from "@prisma/client";
import { seedRbac } from "../scripts/seed-rbac";
import { seedAdminFoundation } from "../scripts/seed-admin-foundation";

// Seeding is a one-off admin task — use the direct / session-pooler connection
// so bulk writes and transactions aren't affected by the pgbouncer pooler.
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

type CatSeed = {
  slug: string;
  name: string;
  description?: string;
  heroColor?: string;
  featured?: boolean;
  children: { slug: string; name: string; description?: string }[];
};

const CATEGORIES: CatSeed[] = [
  {
    slug: "living",
    name: "Living",
    description: "Sofas, tables and storage built around how a room is actually used.",
    heroColor: "#e7ece6",
    featured: true,
    children: [
      { slug: "sofas-seating", name: "Sofas & Seating" },
      { slug: "coffee-side-tables", name: "Coffee & Side Tables" },
      { slug: "shelving-media", name: "Shelving & Media" },
      { slug: "armchairs", name: "Armchairs" },
    ],
  },
  {
    slug: "bedroom",
    name: "Bedroom",
    description: "Beds, storage and bedding for a calmer end to the day.",
    heroColor: "#e9e4ec",
    featured: true,
    children: [
      { slug: "beds", name: "Beds & Frames" },
      { slug: "wardrobes-dressers", name: "Wardrobes & Dressers" },
      { slug: "nightstands", name: "Nightstands" },
      { slug: "bedding", name: "Bedding" },
    ],
  },
  {
    slug: "kitchen-dining",
    name: "Kitchen & Dining",
    description: "Everyday cookware and tableware that earns its place on the shelf.",
    heroColor: "#efe6e2",
    featured: true,
    children: [
      { slug: "dining-tables", name: "Dining Tables" },
      { slug: "dining-chairs", name: "Dining Chairs" },
      { slug: "cookware", name: "Cookware" },
      { slug: "tableware", name: "Tableware" },
      { slug: "drinkware", name: "Drinkware" },
    ],
  },
  {
    slug: "textiles",
    name: "Textiles",
    description: "Rugs, cushions and throws in natural fibres.",
    heroColor: "#f0ebe1",
    featured: true,
    children: [
      { slug: "rugs", name: "Rugs" },
      { slug: "cushions-throws", name: "Cushions & Throws" },
      { slug: "curtains", name: "Curtains" },
      { slug: "bath-linen", name: "Bath Linen" },
    ],
  },
  {
    slug: "lighting",
    name: "Lighting",
    description: "Warm, low-glare light for every corner.",
    heroColor: "#efe9df",
    featured: true,
    children: [
      { slug: "floor-lamps", name: "Floor Lamps" },
      { slug: "table-lamps", name: "Table Lamps" },
      { slug: "pendants", name: "Pendants" },
    ],
  },
  {
    slug: "decor",
    name: "Decor",
    description: "Vases, mirrors and objects with a bit of character.",
    heroColor: "#e8e9ec",
    featured: true,
    children: [
      { slug: "vases-objects", name: "Vases & Objects" },
      { slug: "mirrors", name: "Mirrors" },
      { slug: "plants-pots", name: "Plants & Pots" },
      { slug: "wall-art", name: "Wall Art" },
    ],
  },
  {
    slug: "wardrobe",
    name: "Wardrobe",
    description: "A small, well-made rotation of everyday clothing.",
    heroColor: "#efe6e2",
    featured: true,
    children: [
      { slug: "tops", name: "Tops & Shirts" },
      { slug: "knitwear", name: "Knitwear" },
      { slug: "dresses", name: "Dresses" },
      { slug: "outerwear", name: "Outerwear" },
      { slug: "bottoms", name: "Trousers & Skirts" },
    ],
  },
  {
    slug: "bags-accessories",
    name: "Bags & Accessories",
    description: "Carry-everything bags and the small things that go with them.",
    heroColor: "#e7ece6",
    children: [
      { slug: "totes", name: "Totes" },
      { slug: "crossbody", name: "Crossbody Bags" },
      { slug: "backpacks", name: "Backpacks" },
      { slug: "small-goods", name: "Wallets & Small Goods" },
    ],
  },
  {
    slug: "footwear",
    name: "Footwear",
    description: "Comfortable, hard-wearing shoes in a considered palette.",
    heroColor: "#e9e4ec",
    children: [
      { slug: "sneakers", name: "Sneakers" },
      { slug: "loafers", name: "Loafers & Flats" },
      { slug: "boots", name: "Boots" },
      { slug: "sandals", name: "Sandals" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

type Color = { name: string; hex: string };
type ProdSeed = {
  slug: string;
  name: string;
  cat: string; // subcategory slug
  art: string;
  brand?: string;
  price: number; // centavos
  compareAt?: number;
  short: string;
  desc: string;
  highlights: string[];
  specs: Record<string, string>;
  care?: string;
  badges?: string[];
  freeShipping?: boolean;
  colors?: Color[];
  sizes?: string[];
  weightGrams?: number;
  featuredSold?: number;
  rating?: [number, number]; // avg, count
};

const NEUTRALS: Color[] = [
  { name: "Oat", hex: "#e8dfce" },
  { name: "Clay", hex: "#b5533a" },
  { name: "Slate", hex: "#4a4f57" },
  { name: "Sage", hex: "#7c8a71" },
  { name: "Ink", hex: "#23211e" },
];
const WOODS: Color[] = [
  { name: "Oak", hex: "#c8a97e" },
  { name: "Walnut", hex: "#6b4a32" },
  { name: "Black-stained ash", hex: "#2c2a27" },
];
const APPAREL_SIZES = ["XS", "S", "M", "L", "XL"];
const SHOE_SIZES = ["37", "38", "39", "40", "41", "42", "43", "44"];

const PRODUCTS: ProdSeed[] = [
  // ---------------- Living ----------------
  {
    slug: "aro-3-seat-sofa",
    name: "Aro 3-Seat Sofa",
    cat: "sofas-seating",
    art: "sofa",
    price: 3299000,
    compareAt: 3899000,
    short: "A deep, low three-seater with a slipcover you can actually wash.",
    desc: "Aro was drawn for long evenings — a low back, a deep seat, and feather-wrapped foam cushions that keep their shape. The cover is a heavy basketweave in a family of quiet colours, and every panel unzips for washing. Solid pine frame, corner-blocked and glued, with a 10-year frame guarantee.",
    highlights: [
      "Removable, machine-washable slipcover",
      "Feather-wrapped high-resilience foam seats",
      "FSC-certified solid pine frame",
      "10-year frame guarantee",
    ],
    specs: { Width: "232 cm", Depth: "98 cm", Height: "78 cm", "Seat height": "43 cm", Frame: "Solid pine", Filling: "Foam + feather" },
    care: "Machine wash cover cold, tumble dry low, re-fit while slightly damp.",
    badges: ["bestseller", "sale"],
    freeShipping: true,
    colors: [
      { name: "Oat", hex: "#e8dfce" },
      { name: "Fog", hex: "#c4c6c2" },
      { name: "Moss", hex: "#6f7a5c" },
      { name: "Rust", hex: "#a8583f" },
    ],
    weightGrams: 46000,
    featuredSold: 1240,
    rating: [4.7, 318],
  },
  {
    slug: "aro-2-seat-sofa",
    name: "Aro 2-Seat Sofa",
    cat: "sofas-seating",
    art: "sofa",
    price: 2649000,
    short: "The compact Aro — same deep seat, sized for smaller rooms.",
    desc: "Everything that makes the Aro three-seater comfortable, shortened to fit a condo living room or a reading corner. Washable slipcover, feather-wrapped cushions, solid pine frame.",
    highlights: ["Removable, machine-washable slipcover", "Feather-wrapped foam seats", "Fits through a standard doorway", "10-year frame guarantee"],
    specs: { Width: "168 cm", Depth: "98 cm", Height: "78 cm", "Seat height": "43 cm", Frame: "Solid pine" },
    care: "Machine wash cover cold, tumble dry low.",
    freeShipping: true,
    colors: [
      { name: "Oat", hex: "#e8dfce" },
      { name: "Fog", hex: "#c4c6c2" },
      { name: "Moss", hex: "#6f7a5c" },
    ],
    weightGrams: 34000,
    rating: [4.6, 142],
  },
  {
    slug: "perch-lounge-chair",
    name: "Perch Lounge Chair",
    cat: "armchairs",
    art: "chair",
    price: 1490000,
    compareAt: 1790000,
    short: "A sculptural lounge chair with a cord-wrapped back.",
    desc: "Perch pairs a steam-bent oak frame with a hand-wrapped paper-cord back that gives just enough. The seat cushion is wool-blend and buttoned in place. Light enough to move between rooms.",
    highlights: ["Steam-bent solid oak frame", "Hand-wrapped paper cord back", "Wool-blend seat cushion", "Weighs 6.2 kg"],
    specs: { Width: "68 cm", Depth: "74 cm", Height: "79 cm", "Seat height": "40 cm", Frame: "Solid oak" },
    badges: ["sale"],
    colors: [
      { name: "Natural oak", hex: "#c8a97e" },
      { name: "Black-stained oak", hex: "#2c2a27" },
    ],
    weightGrams: 6200,
    rating: [4.8, 96],
  },
  {
    slug: "linea-coffee-table",
    name: "Linea Coffee Table",
    cat: "coffee-side-tables",
    art: "table",
    price: 899000,
    short: "A slim oak coffee table with a single low shelf.",
    desc: "Linea keeps a low profile: a 22 mm solid oak top, tapered legs, and one open shelf for books and remotes. Flat-packed with a five-minute assembly.",
    highlights: ["22 mm solid oak top", "Lower storage shelf", "Tool-light assembly", "Felt floor pads included"],
    specs: { Width: "110 cm", Depth: "55 cm", Height: "38 cm", Material: "Solid oak, oil finish" },
    care: "Wipe with a damp cloth; re-oil yearly with any furniture oil.",
    colors: WOODS,
    weightGrams: 14000,
    rating: [4.5, 74],
  },
  {
    slug: "stack-bookcase",
    name: "Stack Bookcase",
    cat: "shelving-media",
    art: "storage",
    price: 1290000,
    short: "An open five-shelf bookcase you can wall-anchor.",
    desc: "A clean grid of five shelves in a powder-coated steel frame with oak-veneer boards. Anchor strap included — please use it.",
    highlights: ["Powder-coated steel frame", "Five adjustable shelves", "Wall-anchor strap included", "Holds ~40 kg per shelf"],
    specs: { Width: "80 cm", Depth: "34 cm", Height: "180 cm", Material: "Steel + oak veneer" },
    colors: [
      { name: "Warm white", hex: "#efece4" },
      { name: "Graphite", hex: "#3b3b3d" },
      { name: "Sage", hex: "#7c8a71" },
    ],
    weightGrams: 22000,
    rating: [4.4, 53],
  },

  // ---------------- Bedroom ----------------
  {
    slug: "morgen-bed-frame",
    name: "Morgen Bed Frame",
    cat: "beds",
    art: "bed",
    price: 2190000,
    compareAt: 2590000,
    short: "A low platform bed with an upholstered headboard.",
    desc: "Morgen sits low and quiet, with a gently angled headboard wrapped in the same washable weave as our Aro sofa. Sprung slat base, no box spring needed. Under-bed clearance fits our storage boxes.",
    highlights: ["Upholstered, removable headboard cover", "Sprung beech slat base", "26 cm under-bed clearance", "Bolts hidden behind covers"],
    specs: { "Fits mattress": "Queen / King", Height: "95 cm to headboard", "Frame height": "28 cm", Base: "Sprung beechwood slats" },
    badges: ["sale", "bestseller"],
    freeShipping: true,
    colors: [
      { name: "Oat", hex: "#e8dfce" },
      { name: "Fog", hex: "#c4c6c2" },
      { name: "Ink", hex: "#23211e" },
    ],
    sizes: ["Queen", "King"],
    weightGrams: 38000,
    featuredSold: 640,
    rating: [4.7, 205],
  },
  {
    slug: "hopsack-duvet-set",
    name: "Hopsack Washed Cotton Duvet Set",
    cat: "bedding",
    art: "textile",
    price: 429000,
    short: "Stonewashed cotton percale that feels broken-in from night one.",
    desc: "A duvet cover and two pillowcases in 200-thread-count cotton percale, washed for softness and a lived-in crinkle. Coconut-shell buttons, generous sizing, and internal corner ties.",
    highlights: ["Stonewashed cotton percale", "Coconut-shell button closure", "Internal corner ties", "OEKO-TEX certified"],
    specs: { Includes: "1 duvet cover, 2 pillowcases", Fabric: "100% cotton percale", "Thread count": "200" },
    care: "Machine wash warm with like colours. Tumble dry low.",
    colors: [
      { name: "Chalk", hex: "#efece6" },
      { name: "Clay", hex: "#b5764f" },
      { name: "Eucalyptus", hex: "#8a9b86" },
      { name: "Charcoal", hex: "#3d3d3f" },
    ],
    sizes: ["Double", "Queen", "King"],
    weightGrams: 2200,
    featuredSold: 980,
    rating: [4.8, 411],
  },
  {
    slug: "kvist-nightstand",
    name: "Kvist Nightstand",
    cat: "nightstands",
    art: "storage",
    price: 549000,
    short: "A one-drawer nightstand with a cable notch at the back.",
    desc: "Small footprint, soft-close drawer, and a discreet notch so your charger cable disappears behind it. Solid ash legs.",
    highlights: ["Soft-close drawer runner", "Rear cable notch", "Solid ash legs", "Anti-tip friendly"],
    specs: { Width: "42 cm", Depth: "38 cm", Height: "48 cm", Material: "Ash + ash veneer" },
    colors: WOODS,
    weightGrams: 9000,
    rating: [4.5, 61],
  },
  {
    slug: "vale-wardrobe",
    name: "Vale 2-Door Wardrobe",
    cat: "wardrobes-dressers",
    art: "storage",
    price: 2790000,
    short: "A two-door wardrobe with a rail, three shelves and soft-close hinges.",
    desc: "Vale gives you a full-width hanging rail, three adjustable shelves and a deep base drawer, behind flat doors with recessed finger pulls. Ships in two boxes.",
    highlights: ["Full-width hanging rail", "Three adjustable shelves", "Soft-close hinges", "Recessed finger pulls — no handles to knock"],
    specs: { Width: "100 cm", Depth: "58 cm", Height: "200 cm", Material: "Painted MDF + steel rail" },
    freeShipping: true,
    colors: [
      { name: "Warm white", hex: "#efece4" },
      { name: "Clay", hex: "#b07a5c" },
      { name: "Deep green", hex: "#3f5245" },
    ],
    weightGrams: 62000,
    rating: [4.4, 88],
  },

  // ---------------- Kitchen & Dining ----------------
  {
    slug: "board-dining-table",
    name: "Board Dining Table",
    cat: "dining-tables",
    art: "table",
    price: 2490000,
    compareAt: 2990000,
    short: "A solid oak dining table for six, with breadboard ends.",
    desc: "A single thick oak top with classic breadboard ends that let the wood move with the seasons. Trestle base knocks down flat for moving. Seats six comfortably, eight at a push.",
    highlights: ["30 mm solid oak top", "Breadboard ends", "Knock-down trestle base", "Hard-wax oil finish"],
    specs: { Length: "180 cm", Width: "90 cm", Height: "74 cm", Seats: "6–8", Material: "Solid European oak" },
    care: "Blot spills promptly. Refresh with hard-wax oil once or twice a year.",
    badges: ["sale", "bestseller"],
    freeShipping: true,
    colors: WOODS,
    weightGrams: 41000,
    featuredSold: 420,
    rating: [4.9, 176],
  },
  {
    slug: "fold-dining-chair",
    name: "Fold Dining Chair",
    cat: "dining-chairs",
    art: "chair",
    price: 549000,
    short: "A stackable moulded chair with a solid wood base.",
    desc: "A single-piece moulded seat with a subtle lumbar curve, on a solid beech base. Stacks four high. Felt glides included.",
    highlights: ["Contoured single-piece seat", "Solid beech legs", "Stacks 4 high", "Sold individually"],
    specs: { Width: "50 cm", Depth: "53 cm", Height: "80 cm", "Seat height": "46 cm" },
    colors: [
      { name: "Bone", hex: "#e6e1d6" },
      { name: "Clay", hex: "#b5533a" },
      { name: "Slate", hex: "#4a4f57" },
      { name: "Olive", hex: "#6f7350" },
    ],
    weightGrams: 5200,
    featuredSold: 2100,
    rating: [4.6, 233],
  },
  {
    slug: "daily-cast-iron-pan",
    name: "Daily Cast-Iron Pan 26 cm",
    cat: "cookware",
    art: "kitchen",
    price: 289000,
    short: "A pre-seasoned cast-iron pan with a long handle and a helper loop.",
    desc: "Sand-cast in a single piece, machine-polished on the cooking surface so it needs less breaking-in, and pre-seasoned with flaxseed oil. Oven and induction safe.",
    highlights: ["Polished cooking surface", "Pre-seasoned, ready to use", "Induction to oven to grill", "Helper handle for lifting"],
    specs: { Diameter: "26 cm", Weight: "1.9 kg", Material: "Cast iron", "Oven safe": "Yes, to 260°C" },
    care: "Rinse hot, dry on the hob, wipe with a little oil. Never soak.",
    badges: ["bestseller"],
    weightGrams: 1900,
    featuredSold: 3400,
    rating: [4.8, 690],
  },
  {
    slug: "clay-dinnerware-set",
    name: "Clay Stoneware Dinner Set (12-piece)",
    cat: "tableware",
    art: "tableware",
    price: 399000,
    compareAt: 469000,
    short: "Four each of dinner plates, side plates and bowls in reactive-glaze stoneware.",
    desc: "Thrown-look stoneware with a speckled reactive glaze, so every piece lands slightly different. Chip-resistant rims, stackable, dishwasher and microwave safe.",
    highlights: ["Reactive speckled glaze", "Rolled, chip-resistant rims", "Dishwasher & microwave safe", "Replacements sold individually"],
    specs: { Includes: "4 × dinner, 4 × side, 4 × bowl", Material: "Stoneware", "Dinner plate": "27 cm" },
    badges: ["sale"],
    colors: [
      { name: "Oatmeal", hex: "#ded3bf" },
      { name: "Ash grey", hex: "#9a9a93" },
      { name: "Deep green", hex: "#41544a" },
    ],
    weightGrams: 6400,
    featuredSold: 1500,
    rating: [4.7, 388],
  },
  {
    slug: "ripple-glass-tumblers",
    name: "Ripple Glass Tumblers (Set of 4)",
    cat: "drinkware",
    art: "tableware",
    price: 149000,
    short: "Hand-blown tumblers with an uneven ripple you can feel.",
    desc: "Each tumbler is mouth-blown, so the ripple and the weight vary a little. 350 ml — right for water, wine or an old-fashioned.",
    highlights: ["Mouth-blown glass", "350 ml capacity", "Stacks loosely", "Hand wash recommended"],
    specs: { Capacity: "350 ml", Height: "9.5 cm", Includes: "4 tumblers" },
    colors: [
      { name: "Clear", hex: "#dfe6e6" },
      { name: "Smoke", hex: "#8a8681" },
      { name: "Amber", hex: "#b7823f" },
    ],
    weightGrams: 1800,
    rating: [4.6, 121],
  },

  // ---------------- Textiles ----------------
  {
    slug: "field-wool-rug",
    name: "Field Hand-Loomed Wool Rug",
    cat: "rugs",
    art: "rug",
    price: 1890000,
    compareAt: 2290000,
    short: "A flatweave wool rug with a soft colour block down the middle.",
    desc: "Hand-loomed from undyed and plant-dyed wool, reversible, and dense enough to sit flat without a pad on most floors. Every rug is one of a small batch.",
    highlights: ["100% hand-loomed wool", "Reversible flatweave", "Plant-based dyes", "Naturally stain-resistant"],
    specs: { Sizes: "160×230 / 200×300", Pile: "Flatweave, 6 mm", Material: "100% wool", Origin: "Handmade, Panipat" },
    care: "Vacuum without a beater bar. Professional clean only. Rotate twice a year.",
    badges: ["sale"],
    freeShipping: true,
    colors: [
      { name: "Oat / Clay", hex: "#cbb493" },
      { name: "Fog / Ink", hex: "#b4b7b5" },
      { name: "Sand / Sage", hex: "#c3c1a3" },
    ],
    sizes: ["160 × 230 cm", "200 × 300 cm"],
    weightGrams: 16000,
    featuredSold: 310,
    rating: [4.8, 149],
  },
  {
    slug: "weight-linen-cushion",
    name: "Weighted Linen Cushion Cover",
    cat: "cushions-throws",
    art: "textile",
    price: 89000,
    short: "A heavy 100% linen cover with a hidden zip. Insert sold separately.",
    desc: "Pre-washed heavy linen, cut generously so a plump insert fills the corners, with a concealed YKK zip. Sold as a cover only.",
    highlights: ["Pre-washed heavy linen", "Concealed YKK zip", "Generously cut for full corners", "Cover only — inserts sold separately"],
    specs: { Size: "50 × 50 cm", Fabric: "100% washed linen", Closure: "Concealed zip" },
    care: "Machine wash cold, line dry, warm iron if you like.",
    colors: [
      { name: "Chalk", hex: "#efece6" },
      { name: "Oat", hex: "#ddd2ba" },
      { name: "Clay", hex: "#b5764f" },
      { name: "Olive", hex: "#727650" },
      { name: "Ink", hex: "#2b2a27" },
    ],
    weightGrams: 400,
    featuredSold: 2600,
    rating: [4.7, 512],
  },
  {
    slug: "loft-waffle-throw",
    name: "Loft Waffle Cotton Throw",
    cat: "cushions-throws",
    art: "textile",
    price: 179000,
    short: "A big waffle-weave cotton throw for the end of the bed or the sofa.",
    desc: "Airy waffle weave in soft combed cotton, 130 × 180 cm, with hand-knotted tassels. Gets softer every wash.",
    highlights: ["Combed cotton waffle weave", "130 × 180 cm", "Hand-knotted tassels", "Reversible"],
    specs: { Size: "130 × 180 cm", Fabric: "100% cotton", Weight: "900 g" },
    care: "Machine wash cold, tumble dry low, trim loose threads — don't pull.",
    colors: [
      { name: "Chalk", hex: "#efece6" },
      { name: "Sand", hex: "#d8c8ab" },
      { name: "Terracotta", hex: "#b06b4c" },
      { name: "Storm", hex: "#6a7075" },
    ],
    weightGrams: 900,
    rating: [4.6, 187],
  },

  // ---------------- Lighting ----------------
  {
    slug: "arc-floor-lamp",
    name: "Arc Reading Floor Lamp",
    cat: "floor-lamps",
    art: "lighting",
    price: 749000,
    compareAt: 899000,
    short: "A slim arc lamp that reaches over the arm of a sofa.",
    desc: "A weighted marble base, a brushed-metal arc, and an adjustable head with a warm-dim LED that drops to candlelight without flicker. Foot dimmer on the cord.",
    highlights: ["Warm-dim LED (2700K–2000K)", "Weighted marble base", "In-line foot dimmer", "Bulb included"],
    specs: { Height: "160 cm", Reach: "88 cm", Bulb: "Integrated LED, 9 W", Base: "Marble + steel" },
    badges: ["sale"],
    colors: [
      { name: "Brushed brass", hex: "#b79154" },
      { name: "Matte black", hex: "#2a2a2c" },
      { name: "Nickel", hex: "#9fa2a4" },
    ],
    weightGrams: 8600,
    featuredSold: 540,
    rating: [4.7, 164],
  },
  {
    slug: "pebble-table-lamp",
    name: "Pebble Ceramic Table Lamp",
    cat: "table-lamps",
    art: "lighting",
    price: 429000,
    short: "A rounded ceramic lamp with a linen drum shade.",
    desc: "A hand-glazed ceramic body with a natural linen shade and a fabric cord. Inline switch. Takes any E27 bulb up to 40 W — we'd use a warm 2700K.",
    highlights: ["Hand-glazed ceramic base", "Natural linen shade", "Fabric-wrapped cord", "E27 fitting, bulb not included"],
    specs: { Height: "38 cm", "Shade width": "25 cm", Fitting: "E27, max 40 W" },
    colors: [
      { name: "Chalk", hex: "#e9e4d9" },
      { name: "Clay", hex: "#b5764f" },
      { name: "Storm blue", hex: "#5a6b74" },
    ],
    weightGrams: 2400,
    rating: [4.6, 98],
  },
  {
    slug: "halo-pendant",
    name: "Halo Opal Glass Pendant",
    cat: "pendants",
    art: "lighting",
    price: 519000,
    short: "A hand-blown opal glass globe that glows evenly, no hotspot.",
    desc: "Triple-layer opal glass diffuses the light completely, so it's comfortable to sit under. 2 m of adjustable braided cord and a matching ceiling cup.",
    highlights: ["Triple-layer opal glass", "No visible bulb glare", "2 m adjustable braided cord", "E27, dimmable-ready"],
    specs: { Diameter: "25 cm", "Max drop": "200 cm", Fitting: "E27, max 60 W" },
    colors: [
      { name: "Opal / brass", hex: "#c8a86a" },
      { name: "Opal / black", hex: "#2c2c2e" },
    ],
    weightGrams: 2000,
    rating: [4.8, 76],
  },

  // ---------------- Decor ----------------
  {
    slug: "coil-stoneware-vase",
    name: "Coil Stoneware Vase",
    cat: "vases-objects",
    art: "decor",
    price: 159000,
    short: "A tall matte vase with a visible coil-built texture.",
    desc: "Coil-built by hand and left matte, so the ridges catch the light. Watertight for fresh stems; equally happy holding dried grasses.",
    highlights: ["Hand coil-built", "Watertight interior", "Matte reactive glaze", "26 cm tall"],
    specs: { Height: "26 cm", "Opening": "4 cm", Material: "Stoneware" },
    colors: [
      { name: "Chalk", hex: "#e9e4d9" },
      { name: "Ash", hex: "#9a9a93" },
      { name: "Clay", hex: "#b06b4c" },
    ],
    weightGrams: 1400,
    featuredSold: 1900,
    rating: [4.7, 260],
  },
  {
    slug: "lean-floor-mirror",
    name: "Lean Full-Length Floor Mirror",
    cat: "mirrors",
    art: "accessory",
    price: 989000,
    compareAt: 1190000,
    short: "A slim-framed full-length mirror to lean against the wall.",
    desc: "A powder-coated steel frame, only 18 mm wide, around a distortion-free 5 mm mirror. Comes with a wall strap for safety.",
    highlights: ["18 mm slim steel frame", "5 mm distortion-free glass", "Lean or hang", "Safety wall strap included"],
    specs: { Height: "160 cm", Width: "45 cm", Frame: "Powder-coated steel" },
    badges: ["sale"],
    colors: [
      { name: "Warm white", hex: "#efece4" },
      { name: "Graphite", hex: "#3b3b3d" },
      { name: "Clay", hex: "#a8674c" },
    ],
    weightGrams: 12000,
    rating: [4.6, 112],
  },
  {
    slug: "terra-planter-pot",
    name: "Terra Self-Watering Planter",
    cat: "plants-pots",
    art: "plant",
    price: 119000,
    short: "A matte planter with a hidden reservoir and level indicator.",
    desc: "A double-walled planter with a wick and a small float that tells you when the reservoir needs topping up — about every two weeks for most plants.",
    highlights: ["Self-watering wick system", "Water-level float indicator", "Drainage plug for outdoor use", "Two sizes nest for storage"],
    specs: { Sizes: "Ø16 cm / Ø22 cm", Material: "Recycled polypropylene", Reservoir: "0.8 L / 1.6 L" },
    colors: [
      { name: "Chalk", hex: "#e9e4d9" },
      { name: "Sage", hex: "#7c8a71" },
      { name: "Terracotta", hex: "#b06b4c" },
      { name: "Graphite", hex: "#3b3b3d" },
    ],
    sizes: ["Ø16 cm", "Ø22 cm"],
    weightGrams: 700,
    featuredSold: 2200,
    rating: [4.5, 174],
  },

  // ---------------- Wardrobe ----------------
  {
    slug: "everyday-oxford-shirt",
    name: "Everyday Organic Oxford Shirt",
    cat: "tops",
    art: "apparel-top",
    price: 189000,
    short: "A soft-washed oxford in organic cotton with a relaxed collar.",
    desc: "Cut a little roomier through the body, with a soft unlined collar that sits well open or buttoned. Woven from long-staple organic cotton and garment-washed so it's ready to wear straight away.",
    highlights: ["Long-staple organic cotton", "Garment-washed, no shrinkage surprises", "Corozo nut buttons", "Relaxed fit"],
    specs: { Fabric: "100% organic cotton oxford", Fit: "Relaxed", Weight: "140 gsm" },
    care: "Machine wash cold, hang to dry, warm iron.",
    badges: ["bestseller"],
    colors: [
      { name: "White", hex: "#f2f0ea" },
      { name: "Blue stripe", hex: "#9fb4c9" },
      { name: "Sand", hex: "#d8c8ab" },
      { name: "Olive", hex: "#6f7350" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 350,
    featuredSold: 4100,
    rating: [4.7, 903],
  },
  {
    slug: "lofoten-lambswool-sweater",
    name: "Lofoten Lambswool Sweater",
    cat: "knitwear",
    art: "outerwear",
    price: 279000,
    compareAt: 329000,
    short: "A mid-weight crewneck knitted from traceable lambswool.",
    desc: "Knitted in a small mill from lambswool we can trace to the farm, with ribbed cuffs and hem that hold their shape and a slightly dropped shoulder. Warm without bulk.",
    highlights: ["Traceable lambswool", "Fully fashioned, low-waste knit", "Dropped shoulder", "Naturally odour-resistant"],
    specs: { Fabric: "100% lambswool", Gauge: "7gg", Fit: "Regular" },
    care: "Hand wash cool or wool cycle. Dry flat. De-pill gently.",
    badges: ["sale"],
    colors: [
      { name: "Oatmeal", hex: "#ddd2ba" },
      { name: "Moss", hex: "#6f7a5c" },
      { name: "Rust", hex: "#a8583f" },
      { name: "Charcoal", hex: "#3d3d3f" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 500,
    featuredSold: 1300,
    rating: [4.8, 421],
  },
  {
    slug: "clean-line-tee",
    name: "Clean-Line Heavyweight Tee",
    cat: "tops",
    art: "apparel-top",
    price: 79000,
    short: "A structured 220 gsm tee that holds its shape.",
    desc: "Tubular-knit heavyweight cotton with a clean neckline that won't roll, and a boxy, slightly cropped body. The one you reach for.",
    highlights: ["220 gsm tubular-knit cotton", "Ribbed neck that keeps its shape", "Boxy, slightly cropped", "Pre-shrunk"],
    specs: { Fabric: "100% cotton, 220 gsm", Fit: "Boxy" },
    care: "Machine wash cold, tumble dry low.",
    colors: [
      { name: "White", hex: "#f2f0ea" },
      { name: "Bone", hex: "#e6e1d6" },
      { name: "Faded black", hex: "#37363a" },
      { name: "Clay", hex: "#b5764f" },
      { name: "Sage", hex: "#7c8a71" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 250,
    featuredSold: 6200,
    rating: [4.6, 1180],
  },
  {
    slug: "field-overshirt",
    name: "Field Cotton-Twill Overshirt",
    cat: "outerwear",
    art: "outerwear",
    price: 329000,
    short: "A shirt-jacket in dense cotton twill with two chest pockets.",
    desc: "The layer for in-between weather: a heavy brushed cotton twill, a straight cut that works over a tee or a knit, and real horn-look buttons. Wears in beautifully at the elbows and cuffs.",
    highlights: ["Dense brushed cotton twill", "Two flap chest pockets", "Straight, layer-friendly cut", "Garment-dyed"],
    specs: { Fabric: "100% cotton twill, 320 gsm", Fit: "Straight" },
    care: "Machine wash cold inside out. Hang to dry.",
    colors: [
      { name: "Ecru", hex: "#e0d7c3" },
      { name: "Tobacco", hex: "#8a5a3c" },
      { name: "Deep olive", hex: "#5b5f45" },
      { name: "Washed black", hex: "#33323550" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 650,
    rating: [4.7, 276],
  },
  {
    slug: "bias-cut-midi-dress",
    name: "Bias-Cut Cupro Midi Dress",
    cat: "dresses",
    art: "apparel-dress",
    price: 259000,
    short: "A fluid bias-cut dress with a cowl back.",
    desc: "Cut on the bias from a cupro-blend that moves like silk and washes at home. A high scoop front, a low cowl back, and a length that lands mid-calf.",
    highlights: ["Fluid cupro-viscose blend", "Bias cut for movement", "Cowl back", "Machine washable"],
    specs: { Fabric: "70% cupro, 30% viscose", Length: "Midi", Lining: "Unlined" },
    care: "Machine wash cold in a bag. Line dry. Cool iron.",
    badges: ["new"],
    colors: [
      { name: "Bone", hex: "#e6e1d6" },
      { name: "Espresso", hex: "#4a3830" },
      { name: "Deep teal", hex: "#2f5a58" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 300,
    rating: [4.5, 92],
  },
  {
    slug: "wide-leg-trouser",
    name: "Wide-Leg Pleated Trouser",
    cat: "bottoms",
    art: "apparel-dress",
    price: 219000,
    short: "A high-rise wide-leg trouser with a pressed crease.",
    desc: "Tailored from a cotton-linen blend with a touch of stretch, a single forward pleat, and a hem that breaks cleanly. Side pockets sit flat.",
    highlights: ["Cotton-linen blend with 2% stretch", "Single forward pleat", "Hook-and-bar closure", "Unhemmed option in-store"],
    specs: { Fabric: "54% cotton, 44% linen, 2% elastane", Rise: "High", Leg: "Wide" },
    care: "Machine wash cold. Warm iron. Dry clean to keep the crease sharp.",
    colors: [
      { name: "Ecru", hex: "#e0d7c3" },
      { name: "Stone", hex: "#c3b7a5" },
      { name: "Ink", hex: "#2b2a27" },
      { name: "Chocolate", hex: "#4a3830" },
    ],
    sizes: APPAREL_SIZES,
    weightGrams: 420,
    rating: [4.6, 148],
  },

  // ---------------- Bags & Accessories ----------------
  {
    slug: "carryall-canvas-tote",
    name: "Carryall Waxed-Canvas Tote",
    cat: "totes",
    art: "bag",
    price: 219000,
    compareAt: 259000,
    short: "A structured waxed-canvas tote with a laptop sleeve and a base that stands up.",
    desc: "18 oz waxed canvas over a firm base, so it stands open on the floor. Inside: a padded 14\" laptop sleeve, two slip pockets and a key leash. Leather handles darken with use.",
    highlights: ["18 oz waxed cotton canvas", "Padded 14\" laptop sleeve", "Stands up on its own", "Vegetable-tanned leather handles"],
    specs: { Dimensions: "38 × 34 × 13 cm", "Laptop fit": '14"', Weight: "780 g" },
    care: "Spot clean. Re-wax yearly with any canvas wax.",
    badges: ["sale", "bestseller"],
    colors: [
      { name: "Field tan", hex: "#b08a5c" },
      { name: "Olive", hex: "#5f6449" },
      { name: "Charcoal", hex: "#3b3b3d" },
      { name: "Black", hex: "#262626" },
    ],
    weightGrams: 780,
    featuredSold: 2800,
    rating: [4.8, 505],
  },
  {
    slug: "day-crossbody-bag",
    name: "Day Leather Crossbody",
    cat: "crossbody",
    art: "bag",
    price: 289000,
    short: "A compact crossbody in vegetable-tanned leather with a magnetic flap.",
    desc: "Just enough for a phone, a small wallet and keys. Full-grain vegetable-tanned leather that develops a patina, an adjustable webbing strap, and a hidden back pocket.",
    highlights: ["Full-grain vegetable-tanned leather", "Adjustable webbing strap", "Hidden back slip pocket", "Magnetic flap closure"],
    specs: { Dimensions: "20 × 14 × 6 cm", Strap: "Adjustable to 130 cm", Leather: "Full-grain, 1.8 mm" },
    care: "Condition twice a year. Keep out of prolonged sun.",
    colors: [
      { name: "Tan", hex: "#b5824f" },
      { name: "Cognac", hex: "#8a4f31" },
      { name: "Black", hex: "#262626" },
    ],
    weightGrams: 420,
    rating: [4.7, 213],
  },
  {
    slug: "commute-roll-backpack",
    name: "Commute Roll-Top Backpack",
    cat: "backpacks",
    art: "bag",
    price: 319000,
    short: "A roll-top backpack in recycled ripstop with a clamshell laptop bay.",
    desc: "A weather-sealed roll top over a main compartment, plus a separate padded 16\" laptop bay that opens flat for security checks. Made from recycled ripstop with a PFC-free water-repellent finish.",
    highlights: ["Recycled ripstop, PFC-free DWR", "Clamshell 16\" laptop bay", "Roll-top main compartment", "Sternum strap + luggage pass-through"],
    specs: { Capacity: "22 L (expandable to 28 L)", "Laptop fit": '16"', Weight: "920 g" },
    badges: ["new"],
    colors: [
      { name: "Black", hex: "#262626" },
      { name: "Storm", hex: "#585f63" },
      { name: "Olive", hex: "#5f6449" },
    ],
    weightGrams: 920,
    featuredSold: 760,
    rating: [4.7, 189],
  },
  {
    slug: "fold-bifold-wallet",
    name: "Fold Slim Bifold Wallet",
    cat: "small-goods",
    art: "accessory",
    price: 99000,
    short: "A slim bifold in vegetable-tanned leather — cards, a few notes, done.",
    desc: "Four card slots, a full-width note pocket, and a centre pull-tab for your two most-used cards. Skived thin at the folds so it stays slim even when full.",
    highlights: ["Vegetable-tanned full-grain leather", "4 card slots + pull-tab", "Edges hand-burnished", "Ages to a deep patina"],
    specs: { Dimensions: "10.5 × 8 cm closed", Capacity: "6–8 cards + notes", Leather: "1.2 mm full-grain" },
    colors: [
      { name: "Tan", hex: "#b5824f" },
      { name: "Cognac", hex: "#8a4f31" },
      { name: "Black", hex: "#262626" },
      { name: "Olive", hex: "#5f6449" },
    ],
    weightGrams: 60,
    featuredSold: 3300,
    rating: [4.6, 447],
  },

  // ---------------- Footwear ----------------
  {
    slug: "street-low-sneaker",
    name: "Street Low Leather Sneaker",
    cat: "sneakers",
    art: "footwear",
    price: 359000,
    compareAt: 419000,
    short: "A clean low-top in full-grain leather on a cup sole.",
    desc: "A minimal court silhouette in supple full-grain leather, stitched — not glued — to a natural rubber cup sole, over a removable cork-latex footbed. Made in a family-run Portuguese factory.",
    highlights: ["Full-grain leather upper", "Stitched natural rubber cup sole", "Removable cork-latex footbed", "Made in Portugal"],
    specs: { Upper: "Full-grain leather", Sole: "Natural rubber", Lining: "Vegetable-tanned leather", Fit: "True to size" },
    care: "Brush off dirt, condition the leather, air dry away from heat.",
    badges: ["sale", "bestseller"],
    colors: [
      { name: "White", hex: "#ece7dd" },
      { name: "Bone", hex: "#ddd2ba" },
      { name: "Black", hex: "#262626" },
      { name: "Forest", hex: "#33463a" },
    ],
    sizes: SHOE_SIZES,
    weightGrams: 900,
    featuredSold: 2400,
    rating: [4.7, 618],
  },
  {
    slug: "town-leather-loafer",
    name: "Town Leather Loafer",
    cat: "loafers",
    art: "footwear",
    price: 389000,
    short: "A soft, unlined loafer with a flexible flat sole.",
    desc: "Hand-lasted from soft calf leather, unlined so it moulds to your foot within a week, on a thin flexible sole with a discreet rubber insert at the ball and heel.",
    highlights: ["Soft unlined calf leather", "Hand-lasted", "Flexible leather sole with rubber inserts", "Resoleable"],
    specs: { Upper: "Calf leather", Sole: "Leather + rubber inserts", Fit: "Size down if between sizes" },
    colors: [
      { name: "Chestnut", hex: "#8a5a3c" },
      { name: "Black", hex: "#262626" },
      { name: "Ecru", hex: "#ddd2ba" },
    ],
    sizes: SHOE_SIZES,
    weightGrams: 700,
    rating: [4.6, 231],
  },
  {
    slug: "trail-chelsea-boot",
    name: "Trail Water-Resistant Chelsea Boot",
    cat: "boots",
    art: "footwear",
    price: 469000,
    short: "A Chelsea boot on a lugged sole, built for wet pavements.",
    desc: "Water-resistant oiled leather, storm-welted for a tighter seal against the sole, on a cushioned lugged outsole with real grip. Elastic side panels are recycled.",
    highlights: ["Water-resistant oiled leather", "Storm welt construction", "Cushioned lugged outsole", "Recycled elastic gussets"],
    specs: { Upper: "Oiled full-grain leather", Sole: "Rubber lug, Goodyear-welt-style", Fit: "True to size" },
    care: "Wax regularly. Dry slowly, never on a radiator. Re-welt when the tread wears.",
    badges: ["bestseller"],
    colors: [
      { name: "Dark brown", hex: "#4a3226" },
      { name: "Black", hex: "#262626" },
      { name: "Sand suede", hex: "#c3a780" },
    ],
    sizes: SHOE_SIZES,
    weightGrams: 1200,
    featuredSold: 890,
    rating: [4.8, 342],
  },
  {
    slug: "quay-leather-sandal",
    name: "Quay Molded Leather Sandal",
    cat: "sandals",
    art: "footwear",
    price: 219000,
    short: "A two-strap sandal on a cork footbed that takes your print.",
    desc: "Vegetable-tanned leather straps on a contoured cork-latex footbed that moulds to your foot, with a grippy recycled-rubber outsole. Adjustable buckles at both straps.",
    highlights: ["Vegetable-tanned leather straps", "Contoured cork-latex footbed", "Recycled-rubber outsole", "Both straps adjustable"],
    specs: { Upper: "Vegetable-tanned leather", Footbed: "Cork-latex", Sole: "Recycled rubber" },
    colors: [
      { name: "Tan", hex: "#b5824f" },
      { name: "Black", hex: "#262626" },
      { name: "White", hex: "#ece7dd" },
    ],
    sizes: SHOE_SIZES,
    weightGrams: 500,
    rating: [4.4, 118],
  },
];

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

const COUPONS = [
  { code: "WELCOME10", description: "10% off your first order", type: "PERCENT", value: 10, minSubtotal: 100000, maxDiscount: 100000 },
  { code: "AXIARO500", description: "₱500 off orders over ₱5,000", type: "FIXED", value: 50000, minSubtotal: 500000 },
  { code: "FREESHIP", description: "Free standard shipping, no minimum", type: "FREESHIP", value: 0, minSubtotal: 0 },
  { code: "HOME15", description: "15% off furniture & lighting", type: "PERCENT", value: 15, minSubtotal: 300000, maxDiscount: 300000 },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function skuBase(slug: string) {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18);
}

const REVIEW_SNIPPETS = [
  { title: "Exactly as described", body: "Turned up well packed and looks even better in person. The finish is lovely and it went together in about ten minutes." },
  { title: "Worth it", body: "I hesitated at the price but after a few months of daily use I'd buy it again. Feels like it will last." },
  { title: "Really happy", body: "Colour is true to the photos on my monitor. Quality is a step above what I expected at this price." },
  { title: "Good, with a small note", body: "Great overall. One corner of the packaging was dented but the product itself was perfect. Delivery was quick." },
  { title: "Beautiful piece", body: "Gets compliments every time someone comes over. Simple, well made, doesn't shout." },
  { title: "Does the job nicely", body: "Nothing flashy, just well considered. The little details — the cable notch, the felt pads — show someone thought about it." },
];

async function main() {
  console.log("Resetting…");
  await prisma.orderEvent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.review.deleteMany();
  await prisma.wishlistItem.deleteMany();
  await prisma.variantOptionValue.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.productOptionValue.deleteMany();
  await prisma.productOption.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.address.deleteMany();
  await prisma.contentBlock.deleteMany();
  await prisma.contentPage.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.adminAuditLog.deleteMany();
  await prisma.adminInvite.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.user.deleteMany();

  // Categories
  const catIdBySlug = new Map<string, string>();
  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = CATEGORIES[i];
    const parent = await prisma.category.create({
      data: {
        name: c.name,
        slug: c.slug,
        description: c.description,
        heroColor: c.heroColor,
        featured: c.featured ?? false,
        sortOrder: i,
      },
    });
    catIdBySlug.set(c.slug, parent.id);
    for (let j = 0; j < c.children.length; j++) {
      const ch = c.children[j];
      const child = await prisma.category.create({
        data: {
          name: ch.name,
          slug: ch.slug,
          description: ch.description,
          parentId: parent.id,
          sortOrder: j,
        },
      });
      catIdBySlug.set(ch.slug, child.id);
    }
  }
  console.log(`Categories: ${catIdBySlug.size}`);

  // Users — application records only. Passwords + auth live in Supabase Auth
  // (see scripts/seed-auth-users.mjs, which also links supabaseUserId).
  const admin = await prisma.user.create({
    data: { name: "AXIARO Admin", email: "admin@axiaro.test", role: "ADMIN" },
  });
  const demo = await prisma.user.create({
    data: {
      name: "Mara Santos",
      email: "demo@axiaro.test",
      role: "CUSTOMER",
      phone: "+63 917 555 0142",
      addresses: {
        create: [
          {
            label: "Home",
            firstName: "Mara",
            lastName: "Santos",
            recipient: "Mara Santos",
            phone: "+63 917 555 0142",
            line1: "42 Kalayaan Avenue",
            line2: "Unit 5B, Parkview Residences",
            barangay: "Diliman",
            city: "Quezon City",
            province: "Metro Manila",
            region: "NCR",
            postalCode: "1101",
            country: "PH",
            defaultShipping: true,
            defaultBilling: true,
          },
        ],
      },
    },
    include: { addresses: true },
  });
  console.log(`Users: admin + demo (${demo.email} / password123)`);

  // RBAC — roles, permissions, grants (+ links admin@axiaro.test to SUPER_ADMIN)
  await seedRbac(prisma);
  console.log("RBAC: roles + permissions seeded; admin@axiaro.test → SUPER_ADMIN");

  // Admin Panel / CMS foundation — settings registry defaults
  await seedAdminFoundation(prisma, (m) => console.log(`  ${m}`));

  // Products
  let productCount = 0;
  let variantCount = 0;
  const productIdBySlug = new Map<string, string>();

  // Stagger createdAt so "New in" is a believable mix. Products flagged "new"
  // land in the last few days; everything else is spread over ~10 months.
  const now = Date.now();
  const DAY = 86400000;
  let newCursor = 0;
  const orderedForDates = [...PRODUCTS];

  for (let pIndex = 0; pIndex < orderedForDates.length; pIndex++) {
    const p = orderedForDates[pIndex];
    const categoryId = catIdBySlug.get(p.cat);
    if (!categoryId) throw new Error(`Unknown category ${p.cat} for ${p.slug}`);

    const isNew = (p.badges ?? []).includes("new");
    const createdAt = isNew
      ? new Date(now - (2 + newCursor++) * DAY - (pIndex % 5) * 3600000)
      : new Date(now - (14 + ((pIndex * 37) % 300)) * DAY);

    const [ratingAvg, ratingCount] = p.rating ?? [4.6, 40];

    const product = await prisma.product.create({
      data: {
        name: p.name,
        slug: p.slug,
        brand: p.brand ?? "AXIARO",
        shortDescription: p.short,
        description: p.desc,
        categoryId,
        price: p.price,
        compareAtPrice: p.compareAt ?? null,
        badges: JSON.stringify(p.badges ?? []),
        highlights: JSON.stringify(p.highlights),
        specs: JSON.stringify(p.specs),
        care: p.care ?? null,
        freeShipping: p.freeShipping ?? p.price >= 250000,
        featured: (p.badges ?? []).includes("bestseller"),
        weightGrams: p.weightGrams ?? 500,
        ratingAvg,
        ratingCount,
        soldCount: p.featuredSold ?? Math.floor(ratingCount * 3.5),
        createdAt,
        images: {
          create: [0, 1, 2].map((n) => ({
            url: `art:${p.art}:${p.slug}-${n}`,
            alt: `${p.name} — view ${n + 1}`,
            sortOrder: n,
          })),
        },
      },
    });
    productIdBySlug.set(p.slug, product.id);

    // Options
    const optionRecords: { name: string; valueIds: Map<string, string> }[] = [];

    if (p.colors?.length) {
      const opt = await prisma.productOption.create({
        data: { productId: product.id, name: "Colour", sortOrder: 0 },
      });
      const valueIds = new Map<string, string>();
      for (let i = 0; i < p.colors.length; i++) {
        const v = await prisma.productOptionValue.create({
          data: { optionId: opt.id, value: p.colors[i].name, swatchHex: p.colors[i].hex, sortOrder: i },
        });
        valueIds.set(p.colors[i].name, v.id);
      }
      optionRecords.push({ name: "Colour", valueIds });
    }

    if (p.sizes?.length) {
      const opt = await prisma.productOption.create({
        data: { productId: product.id, name: "Size", sortOrder: 1 },
      });
      const valueIds = new Map<string, string>();
      for (let i = 0; i < p.sizes.length; i++) {
        const v = await prisma.productOptionValue.create({
          data: { optionId: opt.id, value: p.sizes[i], sortOrder: i },
        });
        valueIds.set(p.sizes[i], v.id);
      }
      optionRecords.push({ name: "Size", valueIds });
    }

    // Variants — cartesian product of option values (or a single default)
    const base = skuBase(p.slug);
    const colorList = p.colors?.map((c) => c.name) ?? [null];
    const sizeList = p.sizes ?? [null];
    let vi = 0;

    for (const color of colorList) {
      for (const size of sizeList) {
        vi++;
        const seedNum = (p.slug.length * 7 + vi * 13) % 17;
        const stock = color === null && size === null ? 40 + seedNum : 3 + ((seedNum * 3) % 22);
        const variant = await prisma.variant.create({
          data: {
            productId: product.id,
            sku: `${base}-${String(vi).padStart(2, "0")}`,
            price: p.price,
            compareAtPrice: p.compareAt ?? null,
            stock,
            imageUrl:
              color !== null
                ? `art:${p.art}:${p.slug}-${color.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
                : `art:${p.art}:${p.slug}-0`,
          },
        });
        variantCount++;

        const links: { variantId: string; optionValueId: string }[] = [];
        for (const rec of optionRecords) {
          const key = rec.name === "Colour" ? color : size;
          if (key && rec.valueIds.has(key)) {
            links.push({ variantId: variant.id, optionValueId: rec.valueIds.get(key)! });
          }
        }
        if (links.length) await prisma.variantOptionValue.createMany({ data: links });
      }
    }

    // A couple of reviews per product
    const nReviews = Math.min(3, 1 + (p.slug.length % 3));
    for (let r = 0; r < nReviews; r++) {
      const snip = REVIEW_SNIPPETS[(p.slug.length + r) % REVIEW_SNIPPETS.length];
      const rater = r === 0 ? demo : admin;
      await prisma.review
        .create({
          data: {
            productId: product.id,
            userId: rater.id,
            rating: r === 0 ? Math.round(ratingAvg) : Math.max(4, Math.round(ratingAvg)),
            title: snip.title,
            body: snip.body,
            verified: true,
            createdAt: new Date(Date.now() - (r + 1) * 86400000 * 9),
          },
        })
        .catch(() => {});
    }

    productCount++;
  }
  console.log(`Products: ${productCount}, variants: ${variantCount}`);

  // Wishlist for demo user
  for (const slug of ["aro-3-seat-sofa", "field-wool-rug", "street-low-sneaker", "arc-floor-lamp"]) {
    const id = productIdBySlug.get(slug);
    if (id) await prisma.wishlistItem.create({ data: { userId: demo.id, productId: id } });
  }

  // Coupons
  for (const c of COUPONS) {
    await prisma.coupon.create({
      data: {
        code: c.code,
        description: c.description,
        type: c.type,
        value: c.value,
        minSubtotal: c.minSubtotal,
        maxDiscount: c.maxDiscount ?? null,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 120),
        active: true,
      },
    });
  }
  console.log(`Coupons: ${COUPONS.length}`);

  // Inventory ledger — one row per variant, mirroring Variant.stock
  const allVariants = await prisma.variant.findMany({ select: { id: true, sku: true, stock: true } });
  for (const v of allVariants) {
    await prisma.inventory.upsert({
      where: { variantId: v.id },
      update: { quantity: v.stock, sku: v.sku },
      create: { variantId: v.id, sku: v.sku, quantity: v.stock, reserved: 0, reorderPoint: 3 },
    });
  }
  console.log(`Inventory: ${allVariants.length} variant records`);

  // Store settings — seeded from src/lib/constants.ts
  const STORE_SETTINGS: {
    key: string;
    value: unknown;
    type: string;
    label: string;
    group: string;
  }[] = [
    { key: "site.name", value: "AXIARO", type: "string", label: "Legal / system name", group: "brand" },
    { key: "site.brand", value: "Axiaro", type: "string", label: "Display brand name", group: "brand" },
    { key: "site.tagline", value: "Considered things for everyday living", type: "string", label: "Tagline", group: "brand" },
    { key: "site.description", value: "AXIARO is a modern homeware and lifestyle store — furniture, kitchen, textiles and wardrobe essentials, designed to last and priced fairly.", type: "string", label: "Meta description", group: "brand" },
    { key: "currency", value: "PHP", type: "string", label: "Currency", group: "checkout" },
    { key: "shipping.freeThreshold", value: 250000, type: "number", label: "Free shipping threshold (centavos)", group: "checkout" },
    { key: "shipping.standardFee", value: 12900, type: "number", label: "Standard shipping fee (centavos)", group: "checkout" },
    { key: "shipping.expressFee", value: 24900, type: "number", label: "Express shipping fee (centavos)", group: "checkout" },
    { key: "shipping.methods", value: [
      { id: "standard", label: "Standard delivery", detail: "3–7 business days", fee: 12900 },
      { id: "express", label: "Express delivery", detail: "1–3 business days", fee: 24900 },
    ], type: "json", label: "Shipping methods", group: "checkout" },
    { key: "payment.methods", value: [
      { id: "COD", label: "Cash on delivery", detail: "Pay the courier when your order arrives" },
      { id: "CARD", label: "Credit / debit card", detail: "Visa, Mastercard, JCB" },
      { id: "GCASH", label: "GCash", detail: "Pay via your GCash wallet" },
    ], type: "json", label: "Payment methods", group: "checkout" },
    { key: "returns.windowDays", value: 30, type: "number", label: "Return window (days)", group: "policy" },
    { key: "guarantee.furnitureYears", value: 10, type: "number", label: "Furniture frame guarantee (years)", group: "policy" },
  ];
  for (const s of STORE_SETTINGS) {
    const value = s.type === "string" ? String(s.value) : JSON.stringify(s.value);
    await prisma.storeSetting.upsert({
      where: { key: s.key },
      update: { value, type: s.type, label: s.label, group: s.group },
      create: { key: s.key, value, type: s.type, label: s.label, group: s.group },
    });
  }
  console.log(`Store settings: ${STORE_SETTINGS.length}`);

  // A sample delivered + in-transit order for the demo account
  const sofa = await prisma.product.findUnique({
    where: { slug: "aro-3-seat-sofa" },
    include: { variants: true },
  });
  const lamp = await prisma.product.findUnique({
    where: { slug: "pebble-table-lamp" },
    include: { variants: true },
  });
  const addr = demo.addresses[0];

  if (sofa && lamp && addr) {
    const mkAddressSnapshot = {
      recipient: addr.recipient,
      phone: addr.phone,
      line1: addr.line1,
      line2: addr.line2,
      barangay: addr.barangay,
      city: addr.city,
      province: addr.province,
      region: addr.region,
      postalCode: addr.postalCode,
    };

    const order1Sub = sofa.price;
    await prisma.order.create({
      data: {
        orderNumber: "AX-240418-7731",
        userId: demo.id,
        email: demo.email,
        phone: demo.phone,
        status: "DELIVERED",
        subtotal: order1Sub,
        shippingFee: 0,
        discountTotal: 0,
        grandTotal: order1Sub,
        paymentMethod: "CARD",
        paymentStatus: "PAID",
        addressId: addr.id,
        shippingAddress: JSON.stringify(mkAddressSnapshot),
        shippingMethod: "standard",
        placedAt: new Date(Date.now() - 86400000 * 26),
        items: {
          create: [
            {
              productId: sofa.id,
              variantId: sofa.variants[0]?.id,
              name: sofa.name,
              variantLabel: "Oat",
              sku: sofa.variants[0]?.sku,
              imageUrl: "art:sofa:aro-3-seat-sofa-0",
              unitPrice: sofa.price,
              quantity: 1,
              lineTotal: sofa.price,
            },
          ],
        },
        events: {
          create: [
            { status: "PENDING", title: "Order placed", createdAt: new Date(Date.now() - 86400000 * 26) },
            { status: "PAID", title: "Payment confirmed", createdAt: new Date(Date.now() - 86400000 * 26 + 3600000) },
            { status: "PROCESSING", title: "Preparing your order", location: "AXIARO Warehouse, Taguig", createdAt: new Date(Date.now() - 86400000 * 24) },
            { status: "SHIPPED", title: "Handed to courier", location: "Taguig Hub", createdAt: new Date(Date.now() - 86400000 * 22) },
            { status: "OUT_FOR_DELIVERY", title: "Out for delivery", location: "Quezon City", createdAt: new Date(Date.now() - 86400000 * 21) },
            { status: "DELIVERED", title: "Delivered", detail: "Left with resident", location: "Quezon City", createdAt: new Date(Date.now() - 86400000 * 21 + 7200000) },
          ],
        },
      },
    });

    const order2Sub = lamp.price * 2;
    const ship2 = 12900;
    await prisma.order.create({
      data: {
        orderNumber: "AX-240506-9142",
        userId: demo.id,
        email: demo.email,
        phone: demo.phone,
        status: "OUT_FOR_DELIVERY",
        subtotal: order2Sub,
        shippingFee: ship2,
        discountTotal: 0,
        grandTotal: order2Sub + ship2,
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        addressId: addr.id,
        shippingAddress: JSON.stringify(mkAddressSnapshot),
        shippingMethod: "standard",
        placedAt: new Date(Date.now() - 86400000 * 3),
        items: {
          create: [
            {
              productId: lamp.id,
              variantId: lamp.variants[0]?.id,
              name: lamp.name,
              variantLabel: "Chalk",
              sku: lamp.variants[0]?.sku,
              imageUrl: "art:lighting:pebble-table-lamp-0",
              unitPrice: lamp.price,
              quantity: 2,
              lineTotal: order2Sub,
            },
          ],
        },
        events: {
          create: [
            { status: "PENDING", title: "Order placed", createdAt: new Date(Date.now() - 86400000 * 3) },
            { status: "PROCESSING", title: "Preparing your order", location: "AXIARO Warehouse, Taguig", createdAt: new Date(Date.now() - 86400000 * 2) },
            { status: "SHIPPED", title: "Handed to courier", location: "Taguig Hub", createdAt: new Date(Date.now() - 86400000 * 1) },
            { status: "OUT_FOR_DELIVERY", title: "Out for delivery", location: "Quezon City", createdAt: new Date(Date.now() - 3600000 * 5) },
          ],
        },
      },
    });
    console.log("Orders: 2 sample orders for demo@axiaro.test");
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
