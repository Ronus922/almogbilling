import type { NextConfig } from "next";

// Security headers applied to every route. CSP ships as Report-Only in this
// first wave — it observes violations (browser console) without blocking, so
// we can collect the real inline/external sources before switching to an
// enforcing Content-Security-Policy in a later wave. Do not add report-uri/
// report-to here (violations are read from the console manually for now).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy-Report-Only",
    value:
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; font-src 'self' data:; frame-ancestors 'self'",
  },
];

const nextConfig: NextConfig = {
  // Produce a standalone server bundle at .next/standalone/ for systemd deployment.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
