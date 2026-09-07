/**
 * PHASE UI-COD-LABEL — checkout COD payment wording.
 *
 * Static-only: the checkout Payment section renders behind auth + a live cart,
 * so this asserts on the source. The COD copy lives in the `!goOnline` branch of
 * the Payment <Section> in checkout-flow.tsx — the only payment text a customer
 * sees today (PayMongo dormant → payment.online false → showPayChoice/goOnline
 * both false).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-cod-label.ts
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const flow = readFileSync(new URL("../src/components/checkout/checkout-flow.tsx", import.meta.url), "utf8");

// New wording
ok("new heading present: 'Cash on Delivery (COD)'", /<span className="block font-medium text-ink">Cash on Delivery \(COD\)<\/span>/.test(flow));
ok("new sub-line present: 'Pay when your order is delivered.'", /<span className="block text-meta text-ink-faint">\s*\n?\s*Pay when your order is delivered\.\s*\n?\s*<\/span>/.test(flow));

// Old wording gone
ok("old COD copy removed ('our team confirms it and arranges payment')", !/our team confirms it and arranges payment/.test(flow));
ok("old COD lead removed (“You’ll pay on delivery.” as the panel text)", !/You’ll pay on delivery\.<\/span> Place your order/.test(flow));

// Placement: inside the `!goOnline` (COD) branch of the Payment section
const paySection = flow.slice(flow.indexOf('title="Payment"'), flow.indexOf('label="Order note"'));
ok("COD copy sits in the `goOnline ? … : ( … )` else branch", /\) : \(\s*\n\s*<div className="rounded-sm bg-surface-sunken px-3 py-2\.5 text-sm">\s*\n\s*<span className="block font-medium text-ink">Cash on Delivery \(COD\)/.test(paySection));
ok("COD copy is above the Place Order button (still in the Payment section)", flow.indexOf("Cash on Delivery (COD)") < flow.lastIndexOf(': "Place order"'));
ok("reuses the existing panel container (rounded-sm bg-surface-sunken px-3 py-2.5)", /Cash on Delivery/.test(paySection) && /rounded-sm bg-surface-sunken px-3 py-2\.5/.test(paySection));

// Non-COD (online) wording untouched
ok("online-payment copy unchanged ('taken to our secure payment page')", /You’ll be taken to our secure payment page/.test(flow) && /Your order is held until payment is\s*\n?\s*confirmed\./.test(flow));
ok("test-mode online notice unchanged", /Test mode — no real charge is made\./.test(flow));

// Logic untouched
ok("goOnline gate unchanged", /const goOnline = payment\.online && \(!payment\.cod \|\| payChoice === "online"\);/.test(flow));
ok("showPayChoice gate unchanged", /const showPayChoice = payment\.cod && payment\.online;/.test(flow));
ok("Place-order button labels unchanged ('Place order' / 'Place order & pay')", /"Place order & pay"/.test(flow) && /: "Place order"/.test(flow));
ok("no payment-status / order / PayMongo / settlement logic touched in this file diff", !/paymentStatus|createOrderFromCart\(|PAYMONGO_|SellerSettlement/.test(flow.slice(flow.indexOf('title="Payment"'), flow.indexOf('label="Order note"'))));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
