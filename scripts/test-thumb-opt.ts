/**
 * Small product thumbnails bypass Vercel Image Optimization.
 *
 * Root cause (2026-09-11): once the Vercel project's Image Optimization quota is
 * spent, `/_next/image` returns HTTP 402 for uncached small widths (32–128) —
 * the tiny cart / checkout / order-line / PDP-rail thumbnails break — while the
 * larger cached widths keep working. Fix: `<ProductImage>` sets `next/image`
 * `unoptimized` for `compact` renders and for a bare `Npx` `sizes` ≤ 128, so
 * those load straight from the (already-`.webp`) source URL. Larger images keep
 * normal optimization.
 *
 * Pure-function checks + static assertions on every <ProductImage> call site.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-thumb-opt.ts
 */
import { readFileSync } from "node:fs";
import { thumbnailBypassesOptimizer, THUMBNAIL_BYPASS_MAX_PX } from "../src/lib/art-ref";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

console.log("\nSMALL-THUMBNAIL IMAGE-OPTIMIZATION BYPASS\n");

// ── pure: the predicate ─────────────────────────────────────────────────────
ok("compact === true → bypass (regardless of sizes)",
  thumbnailBypassesOptimizer({ compact: true }) === true &&
  thumbnailBypassesOptimizer({ compact: true, sizes: "(max-width: 1024px) 100vw, 45vw" }) === true);
ok("bare '64px' → bypass", thumbnailBypassesOptimizer({ sizes: "64px" }) === true);
ok("bare '40px' / '48px' / '56px' / '96px' / '128px' → bypass",
  ["40px", "48px", "56px", "96px", "128px"].every((s) => thumbnailBypassesOptimizer({ sizes: s }) === true));
ok("'  64px  ' (whitespace) → bypass", thumbnailBypassesOptimizer({ sizes: "  64px  " }) === true);
ok(`'${THUMBNAIL_BYPASS_MAX_PX + 1}px' (just over the cap) → NO bypass`,
  thumbnailBypassesOptimizer({ sizes: `${THUMBNAIL_BYPASS_MAX_PX + 1}px` }) === false);
ok("'256px' / '400px' (large fixed) → NO bypass",
  thumbnailBypassesOptimizer({ sizes: "256px" }) === false && thumbnailBypassesOptimizer({ sizes: "400px" }) === false);
ok("a responsive sizes string → NO bypass (stays optimized)",
  thumbnailBypassesOptimizer({ sizes: "(max-width: 640px) 55vw, (max-width: 1024px) 30vw, 25vw" }) === false &&
  thumbnailBypassesOptimizer({ sizes: "(max-width: 1024px) 100vw, 45vw" }) === false);
ok("no sizes, no compact → NO bypass (product cards / wishlist stay optimized)",
  thumbnailBypassesOptimizer({}) === false && thumbnailBypassesOptimizer({ sizes: undefined }) === false);
ok("'64vw' / '64' (not a px value) → NO bypass",
  thumbnailBypassesOptimizer({ sizes: "64vw" }) === false && thumbnailBypassesOptimizer({ sizes: "64" }) === false);

// ── static: ProductImage wiring ────────────────────────────────────────────
{
  const pi = read("src/components/product-image.tsx");
  ok("product-image.tsx: <Image> gets unoptimized={thumbnailBypassesOptimizer({ compact, sizes })}",
    /unoptimized=\{thumbnailBypassesOptimizer\(\{ compact, sizes \}\)\}/.test(pi));
  ok("product-image.tsx: still renders a real URL through next/image with fill (not a plain <img>)",
    /<Image\b[\s\S]*\bfill\b[\s\S]*\bsrc=\{src\}/.test(pi) || /<Image\b[\s\S]*\bsrc=\{src\}[\s\S]*\bfill\b/.test(pi));
  ok("product-image.tsx: the source URL is passed through untouched (src={src})", /src=\{src\}/.test(pi));
  ok("product-image.tsx: still imports next/image", /from "next\/image"/.test(pi));
}

// ── static: every <ProductImage> call site is classified correctly ─────────
type Site = { file: string; needle: RegExp; bypass: boolean; why: string };
const sites: Site[] = [
  // small thumbnails — MUST bypass (compact or bare Npx ≤ 128)
  { file: "src/components/order/order-detail.tsx", needle: /<ProductImage[^>]*compact sizes="64px"/, bypass: true, why: "order line item" },
  { file: "src/components/cart/cart-drawer.tsx", needle: /<ProductImage[^>]*compact sizes="64px"/, bypass: true, why: "cart drawer line" },
  { file: "src/components/cart/cart-view.tsx", needle: /<ProductImage[^>]*compact sizes="96px"/, bypass: true, why: "cart page line" },
  { file: "src/components/checkout/checkout-flow.tsx", needle: /<ProductImage[^>]*compact sizes="48px"/, bypass: true, why: "checkout summary line" },
  { file: "src/app/(shop)/account/orders/page.tsx", needle: /<ProductImage[^>]*compact sizes="40px"/, bypass: true, why: "account order list" },
  { file: "src/components/pdp/product-viewer.tsx", needle: /<ProductImage src=\{img\.url\} alt="" sizes="64px" \/>/, bypass: true, why: "PDP thumbnail rail" },
  { file: "src/components/admin/orders/order-detail-view.tsx", needle: /<ProductImage[^>]*allowArt sizes="40px"/, bypass: true, why: "admin order line" },
  { file: "src/components/admin/catalog/product-images.tsx", needle: /<ProductImage[^>]*allowArt sizes="56px"/, bypass: true, why: "admin image manager" },
  { file: "src/app/admin/(shell)/products/page.tsx", needle: /allowArt\s*\n\s*sizes="40px"/, bypass: true, why: "admin product list row" },
  // large images — MUST stay optimized (no compact, responsive/absent sizes)
  { file: "src/components/product-card.tsx", needle: /<ProductImage\s*\n\s*src=\{product\.image\.url\}/, bypass: false, why: "storefront product card" },
  { file: "src/components/pdp/product-viewer.tsx", needle: /<ProductImage\s*\n\s*src=\{mainImage\.url\}[\s\S]*?sizes="\(max-width: 1024px\) 100vw, 45vw"/, bypass: false, why: "PDP hero" },
  { file: "src/components/wishlist/wishlist-view.tsx", needle: /<ProductImage src=\{p\.image\.url\} alt=\{p\.image\.alt\} \/>/, bypass: false, why: "wishlist card" },
];

for (const s of sites) {
  const src = read(s.file);
  const m = s.needle.exec(src);
  if (!m) { ok(`site present: ${s.file} (${s.why})`, false, "call site not found — update this test"); continue; }
  // Re-derive the predicate from the matched call: compact present, and/or sizes="Npx"
  const call = m[0];
  const compact = /\bcompact\b/.test(call);
  const pxMatch = /sizes="(\d+)px"/.exec(call);
  const derivedBypass = thumbnailBypassesOptimizer({
    compact,
    sizes: pxMatch ? `${pxMatch[1]}px` : (/sizes="\(max-width/.test(call) ? "(max-width: 1024px) 100vw, 45vw" : undefined),
  });
  ok(`${s.why} (${s.file}) → ${s.bypass ? "BYPASS optimizer" : "stays OPTIMIZED"}`,
    derivedBypass === s.bypass, `derived ${derivedBypass}, expected ${s.bypass} · call: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
}

// ── static: nothing about image storage / URLs changed ────────────────────
{
  const ar = read("src/lib/art-ref.ts");
  ok("art-ref.ts: parseArtRef / isPhotoRef unchanged (art: refs still route around <Image>)",
    /url\.startsWith\("art:"\)/.test(ar) && /export function isPhotoRef/.test(ar));
  ok("art-ref.ts: the cap is 128px", THUMBNAIL_BYPASS_MAX_PX === 128);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
