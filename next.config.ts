import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Prisma's engine out of the bundle so its native binary is traced
  // correctly for serverless (Vercel) deploys.
  serverExternalPackages: ["@prisma/client", "prisma", "bcryptjs"],
  experimental: {
    // Enables forbidden() / unauthorized() + forbidden.tsx — used by the admin
    // area to return a real HTTP 403 for signed-in non-admins.
    authInterrupts: true,
  },
};

export default nextConfig;
