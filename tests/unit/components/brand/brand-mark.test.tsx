/**
 * BrandMark slot (issue #347)
 *
 * The fork-owned header/footer brand slot. Its default body renders `BRAND.name`
 * as a bare string (no wrapper element) so vanilla header/footer HTML is
 * unchanged. `BRAND.name` is read from `NEXT_PUBLIC_APP_NAME` at module load, so
 * each case stubs the env and re-imports fresh.
 *
 * @see components/brand/brand-mark.tsx · lib/brand.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function renderBrandMark(appName?: string): Promise<HTMLElement> {
  vi.resetModules();
  if (appName !== undefined) vi.stubEnv('NEXT_PUBLIC_APP_NAME', appName);
  const { BrandMark } = await import('@/components/brand/brand-mark');
  const { container } = render(React.createElement(BrandMark));
  return container;
}

describe('BrandMark default', () => {
  it('renders the default brand name when NEXT_PUBLIC_APP_NAME is unset', async () => {
    const container = await renderBrandMark();
    expect(container.textContent).toBe('Sunrise');
  });

  it('renders the configured brand name from the seam', async () => {
    const container = await renderBrandMark('Acme');
    expect(container.textContent).toBe('Acme');
  });

  it('renders as a bare string with no wrapper element (byte-for-byte header)', async () => {
    const container = await renderBrandMark('Acme');
    // No element node is added — just the text node, so the surrounding <Link>
    // styling is preserved exactly.
    expect(container.children).toHaveLength(0);
  });
});
