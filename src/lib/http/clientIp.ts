import { isIP } from 'node:net';

/**
 * The visitor's IP address — the ONE place the app derives it (13/11/2026).
 *
 * Trusts only `X-Real-IP`, which nginx SETS on every proxied request
 * (`proxy_set_header X-Real-IP $remote_addr`), overwriting anything the client
 * sent. `$remote_addr` is the TCP peer; when the peer is a Cloudflare edge,
 * nginx's realip module (conf.d/cloudflare-realip.conf: `real_ip_header
 * CF-Connecting-IP`, trusted only from Cloudflare's own ranges) has already
 * replaced it with the visitor's address. So the same header is right whether
 * the domain is proxied by Cloudflare or DNS-only (as it is since at least
 * 12/11/2026).
 *
 * Deliberately NOT read:
 *   - `X-Forwarded-For` — nginx APPENDS to whatever the client sent, so its
 *     first entry is attacker-controlled (the old clientIp took exactly that).
 *   - `CF-Connecting-IP` — with the domain DNS-only, a client can send it
 *     straight to the origin and nginx passes it through untouched.
 *
 * No header (a request that did not come through nginx: the timers on
 * localhost, the deploy smoke test, Playwright) or a value that is not an IP
 * → 'unknown'. Used for rate-limit keys and the audit / login logs — never for
 * authorization.
 */
export function getClientIp(req: Request | Headers): string {
  const headers = req instanceof Headers ? req : req.headers;
  const raw = headers.get('x-real-ip')?.trim();
  return raw && isIP(raw) !== 0 ? raw : 'unknown';
}
