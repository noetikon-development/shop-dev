import type { NextConfig } from "next";

/**
 * Baseline security response headers (Step 20).
 *
 * Deliberately conservative — no Content-Security-Policy is set here because a
 * blocking CSP needs per-deployment nonces for Next.js's inline bootstrap script
 * and careful allow-listing of Supabase / Vercel / Google Fonts origins; getting
 * it wrong silently breaks the app. HSTS is already added at the edge by Vercel.
 * These four headers are safe for every response the app serves.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // Keep Prisma's engine out of the bundle so its native binary is traced
  // correctly for serverless (Vercel) deploys.
  serverExternalPackages: ["@prisma/client", "prisma", "bcryptjs", "nodemailer"],
  // Don't advertise the framework in a response header.
  poweredByHeader: false,
  images: {
    remotePatterns: [
      // Supabase Storage — admin-uploaded media (products, categories, CMS).
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
  experimental: {
    // Enables forbidden() / unauthorized() + forbidden.tsx — used by the admin
    // area to return a real HTTP 403 for signed-in non-admins.
    authInterrupts: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
