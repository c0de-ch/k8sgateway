import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone with a minimal server.js — what the Dockerfile ships.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // forbidden() (a real HTTP 403 from a Server Component, rendered by app/admin/forbidden.tsx) is still
  // behind this flag in Next.js 16; without it a role failure could only be shown with status 200.
  experimental: { authInterrupts: true },
  // No NEXT_PUBLIC_* variables anywhere: every IdP/backend setting is server-only
  // and read from process.env at request time, so one image serves every IdP.
};

export default nextConfig;
