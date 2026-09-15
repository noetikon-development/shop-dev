/**
 * Multi-seller checkout — Phase A: pure money-allocation functions.
 *
 * These split one already-computed, order-wide shipping fee or discount
 * across N sellers' (future) SellerOrder rows, proportional to each
 * seller's own merchandise subtotal. They are pure — no Prisma, no
 * database access, no seller/session context, no framework dependency —
 * and are NOT wired into checkout.ts or any live code path yet. That
 * integration is a later phase; this file is the allocation library only.
 *
 * Money convention: every amount here is an integer in the store's minor
 * currency unit (centavos), matching how money is represented everywhere
 * else in this codebase (`checkout.ts`, `state-reconcile.ts`, the Prisma
 * schema's `Int` money columns) — never a float. There is no shared
 * money-utils module in this codebase to import from; `roundHalfUp`
 * (round-to-nearest-centavo, halves away from zero) is instead duplicated
 * locally in `checkout.ts`, `admin/returns-actions.ts`,
 * `seller-return-repository.ts`, and `state-reconcile.ts`. It isn't reused
 * here because it solves a different problem — rounding ONE continuous
 * value to the nearest integer — than allocation, which is splitting ONE
 * already-integer total EXACTLY across N integer buckets. The standard
 * tool for that is the "largest remainder" method (floor every proportional
 * share, then hand out the leftover minor units one at a time), which is
 * what `allocateProportional` below implements.
 */

export type SellerSubtotal = {
  sellerId: string;
  /** That seller's own pre-discount merchandise subtotal, in minor units. */
  merchandiseSubtotal: number;
};

export type SellerAllocation = {
  sellerId: string;
  /** This seller's allocated share of the total, in minor units. */
  amount: number;
};

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer (minor-unit amount); got ${value}.`);
  }
}

function validateSellers(sellers: readonly SellerSubtotal[]): void {
  if (sellers.length === 0) {
    throw new RangeError("allocate*: at least one seller is required.");
  }
  for (const s of sellers) {
    assertNonNegativeInteger(s.merchandiseSubtotal, `merchandiseSubtotal for seller "${s.sellerId}"`);
  }
}

/**
 * Remainder-assignment priority: largest `merchandiseSubtotal` first;
 * ties broken by original array position (never by `sellerId` string
 * comparison, which would reorder on an incidental identifier instead of
 * the caller's own input order — the caller's order is what "order
 * position" is meant to mean here).
 */
function remainderPriorityOrder(sellers: readonly SellerSubtotal[]): number[] {
  return sellers
    .map((_, index) => index)
    .sort((a, b) => {
      const diff = sellers[b].merchandiseSubtotal - sellers[a].merchandiseSubtotal;
      return diff !== 0 ? diff : a - b;
    });
}

/**
 * Splits `total` across `sellers` proportional to `merchandiseSubtotal`.
 *
 * Every seller's base share is `floor(total * subtotal_i / subtotalSum)`;
 * the leftover (`total - sum(floors)`, always in `[0, sellers.length)`) is
 * assigned in `remainderPriorityOrder` order.
 *
 * `capAtOwnSubtotal`:
 *  - `false` (shipping — no per-seller ceiling exists): the ENTIRE
 *    leftover goes to the single top-priority seller in one shot.
 *  - `true` (discount — §H's invariant: an allocation may never exceed
 *    that seller's own subtotal): leftover units are placed one at a time,
 *    skipping any seller already at their own `merchandiseSubtotal` and
 *    offering the unit to the next seller in priority order instead. This
 *    can never fail to place every unit as long as `total <= subtotalSum`
 *    (enforced by `allocateDiscount` before this function is called) —
 *    every base share is already `<= merchandiseSubtotal` by construction
 *    (see the proof in `allocateDiscount`'s doc comment), so there is
 *    always enough aggregate headroom across all sellers combined.
 */
function allocateProportional(
  sellers: readonly SellerSubtotal[],
  total: number,
  capAtOwnSubtotal: boolean,
): SellerAllocation[] {
  if (total === 0) {
    return sellers.map((s) => ({ sellerId: s.sellerId, amount: 0 }));
  }

  const subtotalSum = sellers.reduce((sum, s) => sum + s.merchandiseSubtotal, 0);
  const amounts = new Array<number>(sellers.length).fill(0);

  if (subtotalSum === 0) {
    // No merchandise value to proportion against (every line is free, but
    // a positive amount must still be placed somewhere). The only
    // meaningful notion of "fair" left is an as-even-as-possible split;
    // remainder goes by array position (first sellers get the extra unit)
    // since every seller is tied on subtotal (0). Each exported function's
    // own doc comment states whether reaching this branch is valid input
    // for it — shipping allows it, discount (per its own precondition
    // check) never reaches it.
    const base = Math.floor(total / sellers.length);
    let remainder = total - base * sellers.length;
    for (let i = 0; i < sellers.length; i++) {
      amounts[i] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
    return sellers.map((s, i) => ({ sellerId: s.sellerId, amount: amounts[i] }));
  }

  let allocatedSum = 0;
  for (let i = 0; i < sellers.length; i++) {
    const share = Math.floor((total * sellers[i].merchandiseSubtotal) / subtotalSum);
    amounts[i] = share;
    allocatedSum += share;
  }

  let remainder = total - allocatedSum;
  const order = remainderPriorityOrder(sellers);

  if (!capAtOwnSubtotal) {
    if (remainder > 0) amounts[order[0]] += remainder;
    return sellers.map((s, i) => ({ sellerId: s.sellerId, amount: amounts[i] }));
  }

  while (remainder > 0) {
    let placed = false;
    for (const i of order) {
      if (amounts[i] < sellers[i].merchandiseSubtotal) {
        amounts[i] += 1;
        remainder -= 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Unreachable given allocateDiscount's own precondition check
      // (total <= subtotalSum) — guarded anyway so this function never
      // silently drops money if that precondition is ever violated.
      throw new RangeError("allocateProportional: total exceeds the sum of seller merchandise subtotals.");
    }
  }
  return sellers.map((s, i) => ({ sellerId: s.sellerId, amount: amounts[i] }));
}

/**
 * Allocates one already-computed, order-wide shipping fee across N
 * sellers, proportional to each seller's own `merchandiseSubtotal`.
 *
 * - `sum(result[].amount) === totalShippingFee` exactly, always.
 * - One seller: returns the full fee for that seller, unchanged — no
 *   rounding difference from today's single-seller passthrough.
 * - `totalShippingFee === 0`: every seller gets 0.
 * - Every seller's `merchandiseSubtotal` is 0 (e.g. every line is free,
 *   shipping still charged): falls back to an as-even-as-possible split.
 *   There is no proportionality basis, but shipping is not bounded by
 *   merchandise value, so this is valid (if unusual) input.
 * - A negative or non-integer `merchandiseSubtotal`/`totalShippingFee`
 *   throws `RangeError` — this codebase's existing convention for a
 *   precondition violation (see `seller-profile-repository.ts`).
 */
export function allocateShippingFee(
  sellers: readonly SellerSubtotal[],
  totalShippingFee: number,
): SellerAllocation[] {
  validateSellers(sellers);
  assertNonNegativeInteger(totalShippingFee, "totalShippingFee");
  return allocateProportional(sellers, totalShippingFee, false);
}

/**
 * Allocates one already-computed, order-wide discount across N sellers,
 * proportional to each seller's own PRE-DISCOUNT `merchandiseSubtotal`.
 *
 * Seller commission is unaffected by this function and by the discount it
 * computes: commission is (and remains) calculated on each seller's own
 * pre-discount subtotal elsewhere in checkout — this function only ever
 * determines `SellerOrder.discountAllocated`.
 *
 * - `sum(result[].amount) === totalDiscount` exactly, always.
 * - One seller: returns the full discount for that seller, unchanged —
 *   identical to today's single-seller `discountAllocated = discountTotal`
 *   passthrough in `checkout.ts`.
 * - `totalDiscount === 0`: every seller gets 0.
 * - Invariant: no seller's allocated discount ever exceeds that seller's
 *   own `merchandiseSubtotal`. This matches the existing single-seller
 *   precedent — today's whole-discount passthrough can never exceed the
 *   single seller's subtotal because `evaluateCoupon` (`coupons.ts`)
 *   already caps `discountTotal` at the order-wide subtotal
 *   (`Math.min(discount, subtotal)`). Because a valid `totalDiscount` can
 *   therefore never exceed `sum(merchandiseSubtotal)` — enforced below —
 *   every seller's proportional floor share is already
 *   `<= merchandiseSubtotal` by construction (`floor(total * s_i / sum) <=
 *   total * s_i / sum <= sum * s_i / sum = s_i` whenever `total <= sum`),
 *   and the remainder is placed one unit at a time, skipping any seller
 *   already at their own subtotal.
 * - `totalDiscount` greater than `sum(merchandiseSubtotal)` throws
 *   `RangeError` — including the case where `totalDiscount > 0` while
 *   every seller's subtotal is 0, which cannot arise from a valid checkout
 *   (discount is always `<=` the order-wide subtotal upstream) and would
 *   otherwise force violating the per-seller cap for every seller.
 * - A negative or non-integer `merchandiseSubtotal`/`totalDiscount` throws
 *   `RangeError`.
 */
export function allocateDiscount(
  sellers: readonly SellerSubtotal[],
  totalDiscount: number,
): SellerAllocation[] {
  validateSellers(sellers);
  assertNonNegativeInteger(totalDiscount, "totalDiscount");

  const subtotalSum = sellers.reduce((sum, s) => sum + s.merchandiseSubtotal, 0);
  if (totalDiscount > subtotalSum) {
    throw new RangeError(
      `allocateDiscount: totalDiscount (${totalDiscount}) exceeds the combined merchandiseSubtotal (${subtotalSum}).`,
    );
  }

  return allocateProportional(sellers, totalDiscount, true);
}
