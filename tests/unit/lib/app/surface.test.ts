import { describe, it, expect } from 'vitest';

import { classifySurface } from '@/lib/app/surface';

/**
 * `classifySurface` is the single predicate shared by proxy.ts (server, sets
 * `x-surface`) and SurfaceSync (client, keeps `<html data-surface>` synced). It
 * must agree with itself across both, so the behaviour is pinned here.
 */
describe('classifySurface', () => {
  it('classifies /admin and its descendants as admin', () => {
    expect(classifySurface('/admin')).toBe('admin');
    expect(classifySurface('/admin/')).toBe('admin');
    expect(classifySurface('/admin/users')).toBe('admin');
    expect(classifySurface('/admin/orchestration/agents/123/edit')).toBe('admin');
  });

  it('classifies everything else as consumer', () => {
    expect(classifySurface('/')).toBe('consumer');
    expect(classifySurface('/login')).toBe('consumer');
    expect(classifySurface('/signup')).toBe('consumer');
    expect(classifySurface('/dashboard')).toBe('consumer');
    expect(classifySurface('/settings')).toBe('consumer');
  });

  it('does NOT match a /admin-prefixed sibling (e.g. /administrators)', () => {
    expect(classifySurface('/administrators')).toBe('consumer');
    expect(classifySurface('/admin-tools')).toBe('consumer');
  });
});
