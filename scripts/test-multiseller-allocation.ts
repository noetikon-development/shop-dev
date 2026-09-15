/**
 * Multi-seller checkout — Phase A: allocation-library assertion runner.
 *
 * Pure unit + property-style tests for `allocateShippingFee` /
 * `allocateDiscount` (`src/lib/marketplace/order-allocation.ts`). No
 * database, no Prisma, no fixtures, no network — this file only exercises
 * the two exported pure functions.
 *
 *   node --import tsx scripts/test-multiseller-allocation.ts
 */
import {
  allocateShippingFee,
  allocateDiscount,
  type SellerSubtotal,
  type SellerAllocation,
} from "../src/lib/marketplace/order-allocation";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

function sellers(...subtotals: number[]): SellerSubtotal[] {
  return subtotals.map((merchandiseSubtotal, i) => ({ sellerId: `S${i}`, merchandiseSubtotal }));
}

function sum(result: SellerAllocation[]): number {
  return result.reduce((n, r) => n + r.amount, 0);
}

function byId(result: SellerAllocation[], sellerId: string): number {
  return result.find((r) => r.sellerId === sellerId)?.amount ?? -1;
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof RangeError;
  }
}

function main() {
  // ── 1. one seller ─────────────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1000), 400);
    ok("1 · one seller (shipping) gets the full fee", r.length === 1 && r[0].amount === 400, JSON.stringify(r));
    const d = allocateDiscount(sellers(1000), 250);
    ok("1 · one seller (discount) gets the full discount", d.length === 1 && d[0].amount === 250, JSON.stringify(d));
  }

  // ── 2. two sellers exact split ───────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1000, 3000), 400);
    ok("2 · two sellers exact split — A", byId(r, "S0") === 100, JSON.stringify(r));
    ok("2 · two sellers exact split — B", byId(r, "S1") === 300, JSON.stringify(r));
    ok("2 · two sellers exact split — sum", sum(r) === 400);
  }

  // ── 3. three sellers ─────────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1000, 2000, 3000), 600);
    ok("3 · three sellers — A", byId(r, "S0") === 100, JSON.stringify(r));
    ok("3 · three sellers — B", byId(r, "S1") === 200, JSON.stringify(r));
    ok("3 · three sellers — C", byId(r, "S2") === 300, JSON.stringify(r));
    ok("3 · three sellers — sum", sum(r) === 600);
  }

  // ── 4. unequal subtotals ─────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1, 999), 100);
    ok("4 · unequal subtotals — sum preserved", sum(r) === 100, JSON.stringify(r));
    ok("4 · unequal subtotals — larger seller gets more", byId(r, "S1") > byId(r, "S0"), JSON.stringify(r));
  }

  // ── 5. equal subtotals ───────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(500, 500), 100);
    ok("5 · equal subtotals split evenly", byId(r, "S0") === 50 && byId(r, "S1") === 50, JSON.stringify(r));
  }

  // ── 6/7. odd total requiring remainder, assigned deterministically ──
  {
    // subtotals 1:2, total=1 -> proportional shares 0.333/0.667 -> floors 0/0,
    // remainder 1 goes to the larger-subtotal seller (S1).
    const r = allocateShippingFee(sellers(1, 2), 1);
    ok("6 · odd total — sum preserved", sum(r) === 1, JSON.stringify(r));
    ok("7 · remainder assigned to largest-subtotal seller", byId(r, "S1") === 1 && byId(r, "S0") === 0, JSON.stringify(r));

    // Tie-break by array/original position when subtotals are equal.
    const rTie = allocateShippingFee(sellers(1, 1, 1), 1);
    ok("7 · remainder tie-break — first seller by position wins",
      byId(rTie, "S0") === 1 && byId(rTie, "S1") === 0 && byId(rTie, "S2") === 0, JSON.stringify(rTie));
  }

  // ── 8. zero shipping ─────────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1000, 2000), 0);
    ok("8 · zero shipping — all zero", r.every((x) => x.amount === 0) && sum(r) === 0, JSON.stringify(r));
  }

  // ── 9. zero discount ─────────────────────────────────────────────────
  {
    const d = allocateDiscount(sellers(1000, 2000), 0);
    ok("9 · zero discount — all zero", d.every((x) => x.amount === 0) && sum(d) === 0, JSON.stringify(d));
  }

  // ── 10. zero subtotal edge case ──────────────────────────────────────
  {
    // Shipping: every line free, shipping still charged — valid, falls
    // back to an as-even-as-possible split.
    const r2 = allocateShippingFee(sellers(0, 0), 101);
    ok("10 · zero-subtotal shipping — sum preserved", sum(r2) === 101, JSON.stringify(r2));
    ok("10 · zero-subtotal shipping — as-even-as-possible",
      Math.abs(byId(r2, "S0") - byId(r2, "S1")) <= 1, JSON.stringify(r2));

    const r3 = allocateShippingFee(sellers(0, 0, 0), 10);
    ok("10 · zero-subtotal shipping (3 sellers) — sum preserved", sum(r3) === 10, JSON.stringify(r3));

    // Discount: totalDiscount > 0 while every subtotal is 0 is an invalid,
    // unreachable-from-real-checkout combination — must throw, not corrupt
    // the cap invariant.
    ok("10 · zero-subtotal discount with positive total throws",
      throws(() => allocateDiscount(sellers(0, 0), 5)));
    // But zero discount with zero subtotal is fine (both zero).
    const d0 = allocateDiscount(sellers(0, 0), 0);
    ok("10 · zero-subtotal discount with zero total is valid", sum(d0) === 0, JSON.stringify(d0));
  }

  // ── 11. invalid negative subtotal ────────────────────────────────────
  {
    ok("11 · negative merchandiseSubtotal throws (shipping)",
      throws(() => allocateShippingFee(sellers(-1, 100), 50)));
    ok("11 · negative merchandiseSubtotal throws (discount)",
      throws(() => allocateDiscount(sellers(-1, 100), 50)));
  }

  // ── 12. invalid negative total ───────────────────────────────────────
  {
    ok("12 · negative totalShippingFee throws", throws(() => allocateShippingFee(sellers(100), -1)));
    ok("12 · negative totalDiscount throws", throws(() => allocateDiscount(sellers(100), -1)));
  }

  // ── 13. very small totals ────────────────────────────────────────────
  {
    const r = allocateShippingFee(sellers(1, 1, 1), 1);
    ok("13 · very small total (1 centavo across 3 sellers) — sum preserved", sum(r) === 1, JSON.stringify(r));
    const d = allocateDiscount(sellers(1, 1, 1), 1);
    ok("13 · very small discount (1 centavo across 3 sellers) — sum preserved", sum(d) === 1, JSON.stringify(d));
    ok("13 · very small discount respects per-seller cap", d.every((x, i) => x.amount <= [1, 1, 1][i]), JSON.stringify(d));
  }

  // ── 14. large totals ─────────────────────────────────────────────────
  {
    const big = 999_999_999; // ~10 million pesos in centavos
    const r = allocateShippingFee(sellers(333, 667), big);
    ok("14 · large total — sum preserved exactly", sum(r) === big, JSON.stringify(r));
    const d = allocateDiscount(sellers(big, big), big);
    ok("14 · large discount — sum preserved exactly", sum(d) === big, JSON.stringify(d));
  }

  // ── 15/16/17. sum preserved, deterministic, order-position-only tie-break ──
  {
    const a1 = allocateShippingFee(sellers(37, 41, 53, 61), 1000);
    const a2 = allocateShippingFee(sellers(37, 41, 53, 61), 1000);
    ok("15 · sum(allocations) === total", sum(a1) === 1000, JSON.stringify(a1));
    ok("16 · repeated execution produces identical result", JSON.stringify(a1) === JSON.stringify(a2));

    // "Seller ordering does not create nondeterministic results" — same
    // input array, run twice, must be byte-identical (no reliance on Map/
    // object key iteration order, Date.now(), Math.random(), etc.).
    const inputA = sellers(10, 20, 30);
    const inputB = sellers(10, 20, 30);
    const rA = allocateDiscount(inputA, 33);
    const rB = allocateDiscount(inputB, 33);
    ok("17 · identical input (fresh objects) yields identical output", JSON.stringify(rA) === JSON.stringify(rB));
  }

  // ── 18. shipping and discount use identical core methodology ────────
  {
    // Away from the discount-only cap, both must agree exactly (discount's
    // cap can only ever RESTRICT relative to the uncapped method — when
    // totalDiscount is small relative to every subtotal, the cap never
    // binds and both algorithms must produce the same numbers).
    const subtotals = sellers(1000, 2000, 5000);
    const r = allocateShippingFee(subtotals, 77);
    const d = allocateDiscount(subtotals, 77);
    ok("18 · shipping and discount agree when the cap never binds", JSON.stringify(r) === JSON.stringify(d), `${JSON.stringify(r)} vs ${JSON.stringify(d)}`);
  }

  // ── Invariant H — discount never exceeds a seller's own subtotal ────
  {
    // The exact pathological case from the design audit: three equal
    // sellers, a discount that floors to 0 for everyone, forcing the
    // remainder to be placed unit-by-unit with cap-skipping.
    const d = allocateDiscount(sellers(1, 1, 1), 2);
    ok("H · sum preserved under cap-skipping", sum(d) === 2, JSON.stringify(d));
    ok("H · no seller exceeds their own subtotal", d.every((x, i) => x.amount <= [1, 1, 1][i]), JSON.stringify(d));
    ok("H · remainder spread across two sellers, not stacked on one", d.filter((x) => x.amount > 0).length === 2, JSON.stringify(d));

    // A case where the top-priority seller hits its cap mid-distribution
    // and the waterfall must skip to the next seller.
    const d2 = allocateDiscount(sellers(10, 1, 1), 11);
    ok("H · waterfall skips a capped-out top-priority seller", sum(d2) === 11 && d2.every((x, i) => x.amount <= [10, 1, 1][i]), JSON.stringify(d2));

    // totalDiscount exactly equal to the combined subtotal (100% off) is
    // the boundary — every seller's allocation should equal its own
    // subtotal exactly, never throw.
    const d3 = allocateDiscount(sellers(10, 20, 30), 60);
    ok("H · 100%-off boundary: every seller gets exactly their own subtotal",
      byId(d3, "S0") === 10 && byId(d3, "S1") === 20 && byId(d3, "S2") === 30, JSON.stringify(d3));

    // Exceeding the combined subtotal must throw, never silently clamp.
    ok("H · totalDiscount exceeding combined subtotal throws",
      throws(() => allocateDiscount(sellers(10, 20, 30), 61)));
  }

  // ── Non-integer / float rejection (integer-safe money) ───────────────
  {
    ok("float merchandiseSubtotal throws", throws(() => allocateShippingFee(sellers(10.5), 10)));
    ok("float totalShippingFee throws", throws(() => allocateShippingFee(sellers(10), 10.5)));
    ok("float totalDiscount throws", throws(() => allocateDiscount(sellers(10), 5.5)));
  }

  // ── Empty seller list ─────────────────────────────────────────────────
  {
    ok("empty seller list throws (shipping)", throws(() => allocateShippingFee([], 100)));
    ok("empty seller list throws (discount)", throws(() => allocateDiscount([], 100)));
  }

  // ── Property-style table-driven sweep ────────────────────────────────
  // Seller count 1-10, varied subtotal distributions, varied totals,
  // including deliberately awkward (prime, near-total) amounts.
  {
    let sweepChecked = 0;
    const subtotalPatterns: number[][] = [
      [1],
      [1, 1],
      [1, 2, 3],
      [100, 100, 100, 100],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 10 equal
      [7, 13, 29, 41, 53, 67, 79, 83, 97, 101], // 10 primes, unequal
      [1_000_000, 1],
      [0, 100, 0, 200], // some free sellers mixed in
      [3, 3, 3],
      [999983, 2], // one huge, one tiny (large prime-ish subtotal)
    ];
    const totalsToTry = [0, 1, 2, 3, 7, 10, 99, 100, 101, 1000, 123457];

    for (const pattern of subtotalPatterns) {
      const s = sellers(...pattern);
      const subtotalSum = pattern.reduce((a, b) => a + b, 0);
      for (const total of totalsToTry) {
        sweepChecked++;
        // Shipping: always valid regardless of subtotalSum.
        const r = allocateShippingFee(s, total);
        const rSum = sum(r);
        const rNonNeg = r.every((x) => x.amount >= 0);
        if (rSum !== total || !rNonNeg) {
          ok(`sweep · shipping pattern=${JSON.stringify(pattern)} total=${total}`, false, `sum=${rSum} nonNeg=${rNonNeg}`);
        }

        // Discount: only valid when total <= subtotalSum.
        if (total <= subtotalSum) {
          const d = allocateDiscount(s, total);
          const dSum = sum(d);
          const dNonNeg = d.every((x) => x.amount >= 0);
          const dCapped = d.every((x, i) => x.amount <= pattern[i]);
          if (dSum !== total || !dNonNeg || !dCapped) {
            ok(`sweep · discount pattern=${JSON.stringify(pattern)} total=${total}`, false, `sum=${dSum} nonNeg=${dNonNeg} capped=${dCapped}`);
          }
        } else {
          if (!throws(() => allocateDiscount(s, total))) {
            ok(`sweep · discount pattern=${JSON.stringify(pattern)} total=${total} should throw (exceeds subtotal)`, false);
          }
        }
      }
    }
    ok(`sweep · ${sweepChecked} (pattern × total) combinations checked, all sum/nonneg/cap invariants held`, true);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
