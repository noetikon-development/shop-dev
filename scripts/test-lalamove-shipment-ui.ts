/**
 * Seller shipment UI — Lalamove quote/booking flow (Phase 9F-48 step 7).
 *
 * This project has NO React component-testing framework installed (no
 * vitest/jest/@testing-library/react/jsdom in package.json) — every existing
 * test in this repo is a plain Node/tsx script, and every existing test that
 * covers a component/action's internal wiring (e.g. `test-9f47c.ts`'s
 * "F — repository wiring" section, `test-9f30b.ts`'s "static wiring" section)
 * does so by reading the source file as text and asserting the expected code
 * shape with regex — never by rendering the component. This file follows
 * that SAME established convention for the parts of
 * `order-fulfillment-panel.tsx` that are JSX/effect wiring, and additionally
 * unit-tests the one piece of genuinely pure, side-effect-free logic this
 * task introduced — `quoteFingerprint()` — by importing and calling it for
 * real (it has no React/JSX dependency, so it runs fine under plain Node).
 *
 * `quoteFingerprint()` cannot be imported directly here even though it's a
 * pure function: this file's module (a `"use client"` component) transitively
 * imports both client-only React APIs (`lucide-react`'s `createContext`) and
 * `"use server"` actions that import `server-only` modules — two mutually
 * incompatible module-resolution conditions no single Node/tsx flag
 * combination satisfies (confirmed by trying both `--conditions=react-server`
 * and its absence; each fails on the OTHER half of the import graph). This is
 * exactly why no existing test in this repo imports a component file, only
 * ever its source TEXT. Reimplemented verbatim below and unit-tested for
 * real, plus a static check that the actual file's own implementation is
 * textually identical to what's tested here.
 *
 * No real Lalamove API call, no database access, nothing to roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-lalamove-shipment-ui.ts
 */
import { readFileSync } from "node:fs";

/** Verbatim copy of `quoteFingerprint()` from order-fulfillment-panel.tsx — see the module-level comment above for why it can't be imported directly. */
function quoteFingerprint(carrier: string, serviceType: string, destinationLat: string, destinationLng: string): string {
  return JSON.stringify([carrier, serviceType, destinationLat, destinationLng]);
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function main() {
  console.log("\nSeller shipment UI — Lalamove quote/booking flow\n");

  // ── real unit tests — quoteFingerprint() is pure, no React needed ───────
  console.log("── unit — quoteFingerprint() ──");
  const base = quoteFingerprint("LALAMOVE", "SEDAN", "14.5995", "120.9842");
  ok("same 4 inputs → identical fingerprint", quoteFingerprint("LALAMOVE", "SEDAN", "14.5995", "120.9842") === base);
  ok("D · changing serviceType changes the fingerprint", quoteFingerprint("LALAMOVE", "MPV", "14.5995", "120.9842") !== base);
  ok("D · changing destinationLat changes the fingerprint", quoteFingerprint("LALAMOVE", "SEDAN", "14.6000", "120.9842") !== base);
  ok("D · changing destinationLng changes the fingerprint", quoteFingerprint("LALAMOVE", "SEDAN", "14.5995", "120.9900") !== base);
  ok("D · changing carrier changes the fingerprint", quoteFingerprint("JT_EXPRESS", "SEDAN", "14.5995", "120.9842") !== base);
  ok("fingerprint does not silently collapse distinct inputs (no accidental key collision for adjacent values)",
    quoteFingerprint("LALAMOVE", "SEDAN", "14.59950", "120.9842") !== quoteFingerprint("LALAMOVE", "SEDAN", "14.5995", "0120.9842"));

  // ── static wiring — order-fulfillment-panel.tsx ─────────────────────────
  console.log("\n── static wiring — order-fulfillment-panel.tsx ──");
  const src = read("src/components/seller/order-fulfillment-panel.tsx");

  ok("the real file's quoteFingerprint() is textually identical to the verbatim copy unit-tested above",
    /function quoteFingerprint\(carrier: string, serviceType: string, destinationLat: string, destinationLng: string\): string \{\s*return JSON\.stringify\(\[carrier, serviceType, destinationLat, destinationLng\]\);\s*\}/.test(src));

  ok("carrier selector reuses the existing COURIERS/SHIP_CARRIERS list, no second provider list introduced",
    /const SHIP_CARRIERS = COURIERS\.filter/.test(src) && !/const .*CARRIERS.*=.*\[\s*\{[\s\S]{0,40}code:/.test(src.replace(/LALAMOVE_SERVICE_TYPES[\s\S]*?\];/, "")));

  ok("Lalamove service types are enumerated from the real provider codes (matches LALAMOVE_PH_VEHICLE_CAPACITY's own keys), not invented",
    ["MOTORCYCLE", "SEDAN", "MPV", "VAN", "TRUCK330", "3000KG_TRUCK", "10WHEEL_TRUCK"].every((code) => new RegExp(`code: "${code}"`).test(src)));

  ok("A · isEdit forces isLalamove false — the quote/booking UI never appears while editing an existing shipment",
    /const isEdit = Boolean\(shipment\);/.test(src) && /const isLalamove = !isEdit && carrier === "LALAMOVE";/.test(src));

  ok("A/B · MANUAL fields (carrierName/trackingNumber/trackingUrl) render only when NOT Lalamove — unchanged shape, still present",
    /\{!isLalamove && \(/.test(src) && /name="carrierName"/.test(src) && /name="trackingNumber"/.test(src) && /name="trackingUrl"/.test(src));

  ok("B · Lalamove-only fields (serviceType, destinationLat, destinationLng) render only inside the isLalamove block",
    /\{isLalamove && \(/.test(src) && /name="serviceType"/.test(src) && /name="destinationLat"/.test(src) && /name="destinationLng"/.test(src));

  ok("B · a 'Get quote' control exists, gated by canRequestQuote",
    /Get quote/.test(src) && /disabled=\{!canRequestQuote\}/.test(src));

  ok("quote request FormData sends ONLY sellerOrderId/carrier/serviceType/destinationLat/destinationLng — no package or origin data from the browser",
    (() => {
      const fn = src.slice(src.indexOf("const requestQuote = ()"), src.indexOf("return (\n    <Modal"));
      const sets = [...fn.matchAll(/fd\.set\("([a-zA-Z]+)"/g)].map((m) => m[1]);
      return (
        new Set(sets).size === 5 &&
        ["sellerOrderId", "carrier", "serviceType", "destinationLat", "destinationLng"].every((k) => sets.includes(k)) &&
        !/package|origin/i.test(fn)
      );
    })());

  ok("C · booking is gated on quoteValidForCurrentInputs (a successful, input-matching quote), not just quote.state.ok alone",
    /const canBook = !isLalamove \|\| \(quoteValidForCurrentInputs && !quote\.pending && !form\.pending\);/.test(src));

  ok("C/F · the submit button is disabled by canBook (and form.pending) — Confirm & Book is never enabled without a valid quote",
    /disabled=\{form\.pending \|\| !canBook\}/.test(src));

  ok("C · button label reads 'Confirm & Book' for a genuine Lalamove create, 'Save' for any edit, 'Add shipment' for MANUAL create",
    /\{shipment \? "Save" : isLalamove \? "Confirm & Book" : "Add shipment"\}/.test(src));

  ok("D · every quote-relevant input's onChange calls clearQuote() — carrier, serviceType, destinationLat, destinationLng",
    (src.match(/clearQuote\(\);/g) ?? []).length >= 4);

  ok("D · the confirmed quote fingerprint is captured from pendingQuoteKey (the SNAPSHOT taken at dispatch time), never from live input state at resolve time — avoids crediting a quote to inputs changed mid-flight",
    /setConfirmedQuoteKey\(pendingQuoteKey\);/.test(src) && !/setConfirmedQuoteKey\(quoteFingerprint\(carrier, serviceType, destinationLat, destinationLng\)\);/.test(src));

  ok("E · a quote-action error clears the confirmed quote and notifies, without touching form.state (booking is untouched, modal stays open)",
    /if \(quote\.state\.error\) \{\s*notify\.error\(quote\.state\.error\);\s*setConfirmedQuoteKey\(null\);\s*\}/.test(src));

  ok("F · Get quote is disabled while quote.pending OR form.pending (canRequestQuote requires both false)",
    /const canRequestQuote = Boolean\(serviceType\) && Boolean\(destinationLat\) && Boolean\(destinationLng\) && !quote\.pending && !form\.pending;/.test(src));

  ok("G · Confirm & Book is disabled while form.pending (native form-disable) AND while quote.pending (via canBook)",
    /disabled=\{form\.pending \|\| !canBook\}/.test(src) && /!quote\.pending && !form\.pending\)/.test(src));

  ok("G · no second submission path exists — exactly one <button type=\"submit\"> in this component",
    (src.match(/type="submit"/g) ?? []).length === 1);

  ok("H · the existing carrier-agnostic Shipment display (Row/carrierLabel/trackingNumber/trackingUrl/status) is untouched",
    /<Row label="Carrier">\{shipment\.carrierLabel\}<\/Row>/.test(src) && /<Row label="Tracking #">/.test(src) && /<Row label="Status">\{shipment\.status\}<\/Row>/.test(src));

  ok("I · edit mode can never expose the quote/booking flow — isLalamove is unconditionally false whenever `shipment` is set (see isEdit check above), so a second Lalamove booking can never be started from an edit",
    /const isLalamove = !isEdit && carrier === "LALAMOVE";/.test(src));

  ok("modal-close reset clears carrier/serviceType/destinationLat/destinationLng/pendingQuoteKey/confirmedQuoteKey",
    /if \(!open\) \{\s*setCarrier\(shipment\?\.carrier \?\? ""\);\s*setServiceType\(""\);\s*setDestinationLat\(""\);\s*setDestinationLng\(""\);\s*setPendingQuoteKey\(null\);\s*setConfirmedQuoteKey\(null\);/.test(src));

  ok("existing saveShipmentAction()/getShipmentQuoteAction() are used unmodified — this file imports them, does not redefine them",
    /import \{\s*advanceSellerOrderAction,\s*saveShipmentAction,\s*getShipmentQuoteAction,/.test(src));

  ok("no new backend call, timer, lock, or database marker was introduced in this UI file (no setTimeout/setInterval/fetch/prisma reference)",
    !/setTimeout|setInterval|\bfetch\(|prisma\./.test(src));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
