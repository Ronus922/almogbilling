import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a standalone server bundle at .next/standalone/ for systemd deployment.
  output: "standalone",
};

export default nextConfig;
