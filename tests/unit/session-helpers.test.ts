import { describe, expect, it } from 'vitest';

import { hashToken, tokensMatch, truncateIp } from '@/lib/auth/session';

describe('hashToken', () => {
  it('is deterministic and 64 hex characters', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the token', () => {
    expect(hashToken('super-secret-token')).not.toContain('super-secret-token');
  });
});

describe('truncateIp', () => {
  // Stored truncated so the active-sessions list is recognisable to the user
  // without becoming a location history.
  it('keeps three octets of IPv4', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
  });

  it('keeps the first three groups of IPv6', () => {
    expect(truncateIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::');
  });

  it.each([undefined, '', 'not-an-ip', '10.1'])('returns undefined for %s', (input) => {
    expect(truncateIp(input)).toBeUndefined();
  });
});

describe('tokensMatch', () => {
  it('matches identical strings', () => {
    expect(tokensMatch('abcdef', 'abcdef')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(tokensMatch('abcdef', 'abcdeg')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(tokensMatch('abc', 'abcdef')).toBe(false);
  });
});
