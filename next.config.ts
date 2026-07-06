import type { NextConfig } from "next";

// Security headers applied to every route. CSP is ENFORCING (wave 3b): the
// Report-Only observation wave collected ZERO violations (super_admin, across
// all exports + the main screens), so the policy matches real behaviour and now
// blocks anything off-policy. The value is byte-for-byte the previous
// Report-Only string. Keep it in sync with what the app actually loads; do not
// add report-uri/report-to here.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; font-src 'self' data:; frame-ancestors 'self'",
  },
];

const nextConfig: NextConfig = {
  // Produce a standalone server bundle at .next/standalone/ for systemd deployment.
  output: "standalone",
  // puppeteer-core has dynamic requires that break when webpack-bundled — keep it
  // external so it is required at runtime from node_modules (traced into standalone).
  serverExternalPackages: ["puppeteer-core"],
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
