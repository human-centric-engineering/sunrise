/**
 * The waitlist leave page (§125 t-977): unlike the confirm page it is served
 * whatever the waitlist config says — no switch may stop someone leaving —
 * and it hands the link's token to the button.
 *
 * @see app/(public)/waitlist/leave/page.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WaitlistConfig } from '@/lib/waitlist/config';

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

async function loadPage(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const page = await import('@/app/(public)/waitlist/leave/page');
  const { __resetWaitlistConfigForTests } = await import('@/lib/waitlist/config');
  __resetWaitlistConfigForTests();
  return page.default;
}

/** The props of the first element in the tree whose type is named `name`. */
function findProps(node: unknown, name: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as ReactElement<Record<string, unknown>> & { type: { name?: string } };
  if (typeof el.type === 'function' && el.type.name === name) return el.props;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findProps(child, name);
    if (found) return found;
  }
  return null;
}

describe('WaitlistLeavePage', () => {
  it('is served, with a working leave button, even when the app has no waitlist', async () => {
    const Page = await loadPage(null);

    const tree = await Page({ searchParams: Promise.resolve({ token: 'tok' }) });

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(findProps(tree, 'WaitlistLinkAction')).toMatchObject({
      action: 'leave',
      token: 'tok',
    });
  });

  it('passes the link’s token to the button, and ignores a repeated or missing token', async () => {
    const Page = await loadPage({ consentVersion: 'v1' });

    const tree = await Page({ searchParams: Promise.resolve({ token: 'tok' }) });
    const repeated = await Page({ searchParams: Promise.resolve({ token: ['a', 'b'] }) });
    const missing = await Page({ searchParams: Promise.resolve({}) });

    expect(findProps(tree, 'WaitlistLinkAction')).toMatchObject({ action: 'leave', token: 'tok' });
    expect(findProps(repeated, 'WaitlistLinkAction')).toMatchObject({ token: '' });
    expect(findProps(missing, 'WaitlistLinkAction')).toMatchObject({ token: '' });
  });
});
