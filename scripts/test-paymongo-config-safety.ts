/**
 * PayMongo production-activation safety hardening — tests for the
 * configuration-hygiene audit's confirmed fix: a TEST (or mismatched) key
 * must never activate online payment in genuine Vercel Production, and
 * `VERCEL_ENV` — never `NODE_ENV` — is what distinguishes Production from
 * Preview (Vercel sets `NODE_ENV=production` for BOTH).
 *
 * `computePaymentActivationGates()` is the exact, pure formula
 * `getPaymentsConfig()` uses — extracted so every credential/mode/
 * environment combination can be tested directly, with no database write
 * and no PayMongo API call. `detectKeyMode()` / `isVercelProductionEnvironment()`
 * are unit-tested directly too (the latter via temporary, restored
 * `process.env.VERCEL_ENV` mutation only — never written to disk).
 *
 * No PayMongo API call. No database write. No Production data touched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-paymongo-config-safety.ts
 */
import { readFileSync } from "node:fs";
import {
  detectKeyMode,
  isVercelProductionEnvironment,
  computePaymentActivationGates,
} from "../src/lib/payments/config";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Synthetic, harmless prefix-only values — never a real credential.
const TEST_KEY = "sk_test_unit_test";
const LIVE_KEY = "sk_live_unit_test";

function unitTests() {
  ok("detectKeyMode · sk_test_… → test", detectKeyMode(TEST_KEY) === "test");
  ok("detectKeyMode · sk_live_… → live", detectKeyMode(LIVE_KEY) === "live");
  ok("detectKeyMode · unrecognised prefix → unknown", detectKeyMode("whatever") === "unknown");
  ok("detectKeyMode · undefined → unknown", detectKeyMode(undefined) === "unknown");

  const saved = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "production";
    ok("isVercelProductionEnvironment · VERCEL_ENV=production → true", isVercelProductionEnvironment() === true);
    process.env.VERCEL_ENV = "preview";
    ok("isVercelProductionEnvironment · VERCEL_ENV=preview → false", isVercelProductionEnvironment() === false);
    delete process.env.VERCEL_ENV;
    ok("isVercelProductionEnvironment · unset (local dev) → false", isVercelProductionEnvironment() === false);
  } finally {
    if (saved === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved;
  }
}

// The 8 required scenarios, verbatim.
function matrixTests() {
  // A — Preview + TEST + onlinePaymentEnabled=true + mode test/empty(→test)
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "test", mode: "test", isProdEnv: false,
    });
    ok("A · Preview + TEST key → sessionsEnabled=true", g.sessionsEnabled === true, JSON.stringify(g));
    ok("A · Preview + TEST key → onlinePaymentEnabled=true", g.onlinePaymentEnabled === true, JSON.stringify(g));
  }

  // B — Production + TEST + onlinePaymentEnabled=true + mode test/empty — THE critical safety case
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "test", mode: "test", isProdEnv: true,
    });
    ok("B · Production + TEST key → sessionsEnabled=false (CRITICAL)", g.sessionsEnabled === false, JSON.stringify(g));
    ok("B · Production + TEST key → onlinePaymentEnabled=false (CRITICAL)", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // C — Production + LIVE + onlinePaymentEnabled=true + mode test/empty
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "live", mode: "test", isProdEnv: true,
    });
    ok("C · Production + LIVE key + test mode → sessionsEnabled=false", g.sessionsEnabled === false, JSON.stringify(g));
    ok("C · Production + LIVE key + test mode → onlinePaymentEnabled=false", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // D — Production + LIVE + onlinePaymentEnabled=true + mode=live + webhook present
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "live", mode: "live", isProdEnv: true,
    });
    ok("D · Production + LIVE key + live mode → sessionsEnabled=true", g.sessionsEnabled === true, JSON.stringify(g));
    ok("D · Production + LIVE key + live mode → onlinePaymentEnabled=true", g.onlinePaymentEnabled === true, JSON.stringify(g));
  }

  // E — Preview + LIVE + mode=live — a live key must NEVER activate on Preview
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "live", mode: "live", isProdEnv: false,
    });
    ok("E · Preview + LIVE key (even matching mode) → sessionsEnabled=false", g.sessionsEnabled === false, JSON.stringify(g));
    ok("E · Preview + LIVE key → onlinePaymentEnabled=false", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // F — Production, no PayMongo key
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: false, hasWebhookSecret: false,
      detectedMode: "unknown", mode: "test", isProdEnv: true,
    });
    ok("F · Production, no key → sessionsEnabled=false", g.sessionsEnabled === false, JSON.stringify(g));
    ok("F · Production, no key → onlinePaymentEnabled=false", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // G — Production + LIVE + live mode, webhook secret MISSING
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: false,
      detectedMode: "live", mode: "live", isProdEnv: true,
    });
    ok("G · Production + LIVE + live mode, no webhook secret → sessionsEnabled=true", g.sessionsEnabled === true, JSON.stringify(g));
    ok("G · Production + LIVE + live mode, no webhook secret → onlinePaymentEnabled=false", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // H — Preview + TEST + test mode, webhook secret MISSING
  {
    const g = computePaymentActivationGates({
      onlineSetting: true, hasSecretKey: true, hasWebhookSecret: false,
      detectedMode: "test", mode: "test", isProdEnv: false,
    });
    ok("H · Preview + TEST + test mode, no webhook secret → sessionsEnabled=true", g.sessionsEnabled === true, JSON.stringify(g));
    ok("H · Preview + TEST + test mode, no webhook secret → onlinePaymentEnabled=false", g.onlinePaymentEnabled === false, JSON.stringify(g));
  }

  // Extra: master switch off short-circuits everything, in Production, even with a live key + live mode.
  {
    const g = computePaymentActivationGates({
      onlineSetting: false, hasSecretKey: true, hasWebhookSecret: true,
      detectedMode: "live", mode: "live", isProdEnv: true,
    });
    ok("extra · onlinePaymentEnabled setting off short-circuits even a correct live Production config", g.sessionsEnabled === false);
  }
}

function staticTests() {
  const config = read("src/lib/payments/config.ts");
  const diagnostics = read("src/lib/payments/diagnostics.ts");

  ok(
    "config.ts · environment detection uses VERCEL_ENV, not NODE_ENV, for the production check",
    /process\.env\.VERCEL_ENV === "production"/.test(config),
  );
  ok(
    "config.ts · getPaymentsConfig no longer branches on NODE_ENV for the live-key gate",
    !/liveKeyOutsideProd = detectedMode === "live" && process\.env\.NODE_ENV/.test(config),
  );
  ok(
    "config.ts · a TEST key inside genuine Production is an explicit, separate gate",
    /testKeyInProd = input\.isProdEnv && input\.detectedMode === "test"/.test(config),
  );
  ok(
    "config.ts · modeMismatch combines all three gates (mode disagreement, live-outside-prod, test-inside-prod)",
    /modeMismatch = keyDisagrees \|\| liveKeyOutsideProd \|\| testKeyInProd/.test(config),
  );
  ok(
    "config.ts · getPaymentsConfig() derives isProdEnv from isVercelProductionEnvironment(), not re-implemented inline",
    /const isProdEnv = isVercelProductionEnvironment\(\);/.test(config),
  );
  ok(
    "config.ts · getPaymentsConfig() delegates to the pure, unit-tested gate function (not a re-implementation)",
    /const \{ sessionsEnabled, onlinePaymentEnabled, modeMismatch \} = computePaymentActivationGates\(/.test(config),
  );
  ok(
    "diagnostics.ts · the modeMismatch summary branch reuses isVercelProductionEnvironment(), not a NODE_ENV re-derivation",
    /isProdEnv = isVercelProductionEnvironment\(\)/.test(diagnostics) &&
      !/detectedMode === "live" && process\.env\.NODE_ENV/.test(diagnostics),
  );
}

function main() {
  console.log("\nPayMongo production-activation safety — tests\n");
  console.log("Unit tests (detectKeyMode, isVercelProductionEnvironment)");
  unitTests();
  console.log("\nConfiguration matrix (A–H, computePaymentActivationGates)");
  matrixTests();
  console.log("\nStatic wiring (config.ts + diagnostics.ts)");
  staticTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
