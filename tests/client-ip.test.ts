import { describe, expect, it } from 'vitest';
import { getClientIp } from '@/lib/http/clientIp';

// getClientIp (13/11/2026) trusts ONLY X-Real-IP — the header nginx sets from
// the TCP peer (and, behind Cloudflare, from CF-Connecting-IP of a Cloudflare
// edge only). Everything a client can forge is ignored.
const req = (headers: Record<string, string>) => new Request('http://localhost/x', { headers });

describe('getClientIp', () => {
  it('takes the address nginx set in X-Real-IP', () => {
    expect(getClientIp(req({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(getClientIp(req({ 'x-real-ip': ' 2001:db8::5 ' }))).toBe('2001:db8::5');
  });

  it('ignores a forged X-Forwarded-For — first entry or any other', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('unknown');
  });

  it('ignores a CF-Connecting-IP sent straight to the origin', () => {
    expect(getClientIp(req({ 'cf-connecting-ip': '9.9.9.9' }))).toBe('unknown');
    expect(getClientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('a value that is not an IP address, or no header at all, is "unknown"', () => {
    expect(getClientIp(req({ 'x-real-ip': 'evil, 1.2.3.4' }))).toBe('unknown');
    expect(getClientIp(req({ 'x-real-ip': '<script>' }))).toBe('unknown');
    expect(getClientIp(req({}))).toBe('unknown');
  });

  it('accepts a Headers object', () => {
    expect(getClientIp(new Headers({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
  });
});
