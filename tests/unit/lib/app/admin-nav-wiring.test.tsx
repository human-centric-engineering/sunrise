/**
 * Tests: lib/app/ bootstrap auto-wiring (client realm — admin nav)
 *
 * `components/admin/admin-sidebar.tsx` calls `initAppNav()` at module load so a
 * fork's `registerNavSection()` calls in `lib/app/admin-nav.ts` populate the
 * client-side registry before the sidebar reads it. We swap the hook for one
 * that registers a known section via the REAL registry, then import the sidebar
 * module and assert the section landed — proving the wire end-to-end. Remove the
 * `initAppNav()` call from the sidebar and this fails.
 *
 * @see lib/app/admin-nav.ts · components/admin/admin-sidebar.tsx
 */

import { describe, it, expect, vi } from 'vitest';

// The auto-wired hook registers a known section via the real registry.
vi.mock('@/lib/app/admin-nav', async () => {
  const reg = await vi.importActual<typeof import('@/lib/admin-nav/registry')>(
    '@/lib/admin-nav/registry'
  );
  return {
    initAppNav: (): void =>
      reg.registerNavSection({ title: 'WireTestSection', items: [] }),
  };
});

// Sidebar is a client component; usePathname is the only navigation hook it uses.
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/overview' }));

describe('admin-nav auto-wire (lib/app/admin-nav.ts → admin-sidebar, client realm)', () => {
  it('the sidebar module invokes initAppNav at load, populating the registry', async () => {
    // Act — importing the sidebar runs its top-level initAppNav() call
    await import('@/components/admin/admin-sidebar');
    const { getRegisteredNavSections, __resetNavRegistryForTests } = await import(
      '@/lib/admin-nav/registry'
    );

    // Assert — the section the hook registered is present (the sidebar called it)
    const titles = getRegisteredNavSections().map((s) => s.title);
    expect(titles).toContain('WireTestSection');

    __resetNavRegistryForTests();
  });
});
