/**
 * Integration Test: Legacy "New Provider Model" Redirect
 *
 * The free-text create form was retired in favour of the discovery
 * dialog mounted on the matrix list. This page is now a thin shim
 * that redirects the operator to the new entry point.
 *
 * Test Coverage:
 * - Calls Next.js `redirect()` with the providers page + models tab.
 *
 * @see app/admin/orchestration/provider-models/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirect } from 'next/navigation';

import NewProviderModelRedirect from '@/app/admin/orchestration/provider-models/new/page';

describe('NewProviderModelRedirect', () => {
  beforeEach(() => {
    vi.mocked(redirect).mockClear();
  });

  it('redirects to the providers page with the matrix tab open', () => {
    NewProviderModelRedirect();

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/admin/orchestration/providers?tab=models');
  });
});
