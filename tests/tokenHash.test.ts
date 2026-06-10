import { describe, it, expect } from 'vitest';
import { hashToken } from '@/lib/auth/tokenHash';
import { hashInviteToken } from '@/lib/auth/inviteTokens';

describe('hashToken — tokens are stored hash-only', () => {
  it('produces a 64-char hex SHA-256 digest', () => {
    const h = hashToken('some-raw-token');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same input → same hash, so lookup works)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('the hash is not the raw token (no plaintext at rest)', () => {
    const raw = 'raw-token-value';
    expect(hashToken(raw)).not.toBe(raw);
  });

  it('hashInviteToken matches hashToken (same algorithm)', () => {
    expect(hashInviteToken('xyz')).toBe(hashToken('xyz'));
  });
});
