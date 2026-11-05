/**
 * Unit tests: waitlistInviteWaveSchema (§125 t-978)
 */

import { describe, it, expect } from 'vitest';
import { waitlistInviteWaveSchema, WAITLIST_INVITE_WAVE_MAX } from '@/lib/validations/waitlist';

describe('waitlistInviteWaveSchema', () => {
  it('caps a wave at 50', () => {
    expect(WAITLIST_INVITE_WAVE_MAX).toBe(50);
  });

  it('accepts ticked ids', () => {
    expect(waitlistInviteWaveSchema.parse({ mode: 'ids', ids: ['a', 'b'] })).toEqual({
      mode: 'ids',
      ids: ['a', 'b'],
    });
  });

  it.each(['next', 'sample'] as const)('accepts a bare %s wave', (mode) => {
    expect(waitlistInviteWaveSchema.parse({ mode, count: 10 })).toEqual({ mode, count: 10 });
  });

  it('accepts a list and an answer narrowing', () => {
    const body = {
      mode: 'next',
      count: 5,
      list: 'beta',
      answer: { field: 'role', value: 'dj' },
    };
    expect(waitlistInviteWaveSchema.parse(body)).toEqual(body);
  });

  it('accepts exactly the cap and exactly one', () => {
    expect(waitlistInviteWaveSchema.safeParse({ mode: 'next', count: 50 }).success).toBe(true);
    expect(waitlistInviteWaveSchema.safeParse({ mode: 'sample', count: 1 }).success).toBe(true);
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(waitlistInviteWaveSchema.safeParse({ mode: 'ids', ids }).success).toBe(true);
  });

  it.each([
    ['count 51', { mode: 'next', count: 51 }],
    ['count 0', { mode: 'next', count: 0 }],
    ['count -1', { mode: 'sample', count: -1 }],
    ['a fractional count', { mode: 'next', count: 2.5 }],
    ['a string count', { mode: 'next', count: '5' }],
    ['next with no count', { mode: 'next' }],
    ['51 ids', { mode: 'ids', ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) }],
    ['no ids', { mode: 'ids', ids: [] }],
    ['an empty id', { mode: 'ids', ids: [''] }],
    ['an over-long id', { mode: 'ids', ids: ['x'.repeat(101)] }],
    ['ids with no ids key', { mode: 'ids' }],
    ['an unknown mode', { mode: 'all', count: 5 }],
    ['no mode', { count: 5 }],
    ['an extra key on ids', { mode: 'ids', ids: ['a'], count: 5 }],
    ['an extra key on next', { mode: 'next', count: 5, role: 'ADMIN' }],
    ['list on an ids wave', { mode: 'ids', ids: ['a'], list: 'beta' }],
    ['an invalid list key', { mode: 'next', count: 5, list: 'not a key!' }],
    [
      'an answer with an extra key',
      { mode: 'next', count: 5, answer: { field: 'a', value: 'b', x: 1 } },
    ],
    [
      'an answer with an empty value',
      { mode: 'next', count: 5, answer: { field: 'a', value: '' } },
    ],
    ['an answer with no field', { mode: 'next', count: 5, answer: { value: 'b' } }],
    [
      'an answer value over 200 characters',
      { mode: 'next', count: 5, answer: { field: 'a', value: 'x'.repeat(201) } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(waitlistInviteWaveSchema.safeParse(body).success).toBe(false);
  });
});
