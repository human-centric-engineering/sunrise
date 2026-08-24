// @vitest-environment happy-dom

/**
 * BrandMark slot (issue #347)
 *
 * The fork-owned header/footer brand slot. Its default body renders `BRAND.name`
 * as a bare string (no wrapper element) so vanilla header/footer HTML is
 * unchanged. `BRAND.name` is read from `lib/app/brand.ts` at module load, so
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

async function renderBrandMark(): Promise<HTMLElement> {
  const { BrandMark } = await import('@/components/brand/brand-mark');
  const { container } = render(React.createElement(BrandMark));
  return container;
}

describe('BrandMark default', () => {
  it('renders the default brand name when the seam is unset', async () => {
    const container = await renderBrandMark();
    expect(container.textContent).toBe('Sunrise');
  });

  // Fork-brand cases live in tests/unit/brand-fork-surfaces.test.tsx, which
  // mocks the seam HOISTED. Driving a brand from here needs doMock +
  // resetModules + re-import, which races the module graph and failed on CI.

  it('renders as a bare string with no wrapper element (byte-for-byte header)', async () => {
    const container = await renderBrandMark();
    // No element node is added — just the text node, so the surrounding <Link>
    // styling is preserved exactly.
    expect(container.children).toHaveLength(0);
  });
});
