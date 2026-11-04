/**
 * The waitlist confirm page (§125 t-977): it does not exist without a
 * waitlist, and with one it hands the link's entry and token to the button.
 *
 * @see app/(public)/waitlist/confirm/page.tsx
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
  const page = await import('@/app/(public)/waitlist/confirm/page');
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

describe('WaitlistConfirmPage', () => {
  it('is not found when the app has no waitlist', async () => {
    const Page = await loadPage(null);

    await expect(
      Page({ searchParams: Promise.resolve({ entry: 'e', token: 't' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('passes the link’s entry and token to the button, and ignores repeated params', async () => {
    const Page = await loadPage({ consentVersion: 'v1' });

    const tree = await Page({ searchParams: Promise.resolve({ entry: 'entry-1', token: 'tok' }) });
    const repeated = await Page({
      searchParams: Promise.resolve({ entry: ['a', 'b'], token: 'tok' }),
    });

    expect(findProps(tree, 'WaitlistLinkAction')).toMatchObject({
      action: 'confirm',
      entry: 'entry-1',
      token: 'tok',
    });
    expect(findProps(repeated, 'WaitlistLinkAction')).toMatchObject({ entry: '' });
  });
});
