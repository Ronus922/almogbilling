import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

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

// /chip-order (12/11/2026) is the ONE page that embeds a third-party frame:
// Grow's payment page (developers.grow.business R/the-process — an iframe of
// the url createPaymentProcess returns, on meshulam.co.il / secure. / sandbox.).
// Same policy plus frame-src for those hosts only; Next applies the LAST
// matching header of a key, so this entry replaces the global CSP on that
// path alone and every other route keeps the string above byte for byte.
const CHIP_ORDER_CSP = `${
  SECURITY_HEADERS.find((h) => h.key === "Content-Security-Policy")!.value
}; frame-src 'self' https://meshulam.co.il https://*.meshulam.co.il`;

const nextConfig: NextConfig = {
  // Produce a standalone server bundle at .next/standalone/ for systemd deployment.
  output: "standalone",
  // Pin the workspace root to this directory. When a lockfile exists in a parent
  // directory Turbopack infers THAT as the root and nests the standalone output
  // (.next/standalone/<relative path>/server.js), which breaks postbuild + deploy.
  turbopack: { root: process.cwd() },
  // puppeteer-core has dynamic requires that break when webpack-bundled — keep it
  // external so it is required at runtime from node_modules (traced into standalone).
  serverExternalPackages: ["puppeteer-core"],
  // Browser only: the client bundle has no process.env, so instrumentation-client.ts
  // gets the build environment's SENTRY_DSN inlined under its OWN names. Never
  // list SENTRY_DSN / SENTRY_ENVIRONMENT themselves here — `env` inlines into the
  // server bundles too, and that froze the server's DSN at build time: a build
  // without it dropped the init block (07/10/2026). The server and edge read
  // them at runtime instead (src/lib/sentry-options.ts); tests/sentry-runtime.test.ts
  // fails if they come back. Empty/unset at build → browser Sentry stays off.
  env: {
    SENTRY_CLIENT_DSN: process.env.SENTRY_DSN ?? "",
    SENTRY_CLIENT_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT ?? "",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      // The owners portal and the file proxy serve personal data: never cached
      // by a browser or an intermediary, whatever the route's own headers say.
      ...["/portal", "/portal/:path*", "/api/portal/:path*", "/api/files/:path*"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      })),
      { source: "/chip-order", headers: [{ key: "Content-Security-Policy", value: CHIP_ORDER_CSP }] },
      // The order / tracking pages carry personal flow state — never cached.
      // And no Referer at all (13/11/2026): their URLs carry a secret (the test
      // link's ?test=<token>, the tracking token), which would otherwise ride
      // on every request the page makes — into nginx's access log, and to Grow.
      ...["/chip-order", "/chip-order/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
    ];
  },
};

// Sentry build plugin: source-map upload only runs when SENTRY_AUTH_TOKEN (+ org
// and project) are present in the build environment; otherwise it is a no-op
// that still leaves the runtime SDK wiring in place.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  telemetry: false,
});
