import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Known-device tracking for the Step 21 P2 sign-in alert.
 *
 * We store a SHA-256 hash of the User-Agent (peppered with a server secret) and
 * a short human summary — never the raw UA, never an IP, never a token. The
 * hash is only a per-account "have we seen this browser before?" key.
 *
 * An alert is raised the FIRST time a NEW device signs in for an account that
 * already has at least one known device. The very first device an account ever
 * signs in from becomes the silent baseline (no alert) — otherwise every new
 * customer would get a "new sign-in" email seconds after registering.
 */

const PEPPER = process.env.AUTH_SECRET ?? "axiaro-signin";

export function hashUserAgent(ua: string | null | undefined): string {
  return createHash("sha256").update(`${(ua ?? "").slice(0, 1024)}|${PEPPER}`).digest("hex");
}

/** A coarse, non-identifying summary like "Chrome on Windows" / "Safari on iPhone". */
export function summarizeUserAgent(ua: string | null | undefined): string {
  const s = ua ?? "";
  if (!s) return "Unknown device";

  const os =
    /iPhone|iPad|iPod/i.test(s) ? "iOS" :
    /Android/i.test(s) ? "Android" :
    /Windows NT/i.test(s) ? "Windows" :
    /Mac OS X|Macintosh/i.test(s) ? "macOS" :
    /CrOS/i.test(s) ? "ChromeOS" :
    /Linux/i.test(s) ? "Linux" :
    null;

  const browser =
    /Edg\//i.test(s) ? "Edge" :
    /OPR\/|Opera/i.test(s) ? "Opera" :
    /SamsungBrowser/i.test(s) ? "Samsung Internet" :
    /Firefox\//i.test(s) ? "Firefox" :
    /Chrome\//i.test(s) && !/Chromium/i.test(s) ? "Chrome" :
    /CriOS\//i.test(s) ? "Chrome" :
    /Version\/.*Safari/i.test(s) ? "Safari" :
    null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `${os} device`;
  return "Unknown device";
}

export type SignInRecord = {
  /** true only when this is a genuinely new device AND the account already had one. */
  isNewDevice: boolean;
  deviceSummary: string;
  uaHash: string;
};

/**
 * Record a successful sign-in for `userId` from the given user-agent. Never
 * throws — a failure here must not block login. Returns whether the caller
 * should send a "new sign-in" alert.
 */
export async function recordSignIn(
  userId: string,
  ua: string | null | undefined,
): Promise<SignInRecord> {
  const deviceSummary = summarizeUserAgent(ua);
  const uaHash = hashUserAgent(ua);

  try {
    const existing = await prisma.signInDevice.findUnique({
      where: { userId_uaHash: { userId, uaHash } },
      select: { id: true },
    });

    if (existing) {
      await prisma.signInDevice.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      return { isNewDevice: false, deviceSummary, uaHash };
    }

    const priorDevices = await prisma.signInDevice.count({ where: { userId } });

    try {
      await prisma.signInDevice.create({ data: { userId, uaHash, uaSummary: deviceSummary } });
    } catch {
      // Lost a race with a concurrent sign-in from the same device — the row
      // now exists, so it is not "new".
      return { isNewDevice: false, deviceSummary, uaHash };
    }

    return { isNewDevice: priorDevices > 0, deviceSummary, uaHash };
  } catch {
    // Any DB hiccup — degrade to "not new" so login is never affected and no
    // spurious alert is sent.
    return { isNewDevice: false, deviceSummary, uaHash };
  }
}
