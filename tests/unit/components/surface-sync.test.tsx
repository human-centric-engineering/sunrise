import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { SurfaceSync } from '@/components/surface-sync';

/**
 * SurfaceSync keeps `<html data-surface>` correct across client-side navigation
 * (the root <html> persists, so the proxy header alone goes stale). It derives
 * the surface from the pathname and writes the attribute; it renders nothing.
 */
afterEach(() => {
  vi.mocked(usePathname).mockReturnValue('/'); // restore the global mock default
  delete document.documentElement.dataset.surface;
});

describe('SurfaceSync', () => {
  it('marks the html element admin on an /admin route', () => {
    vi.mocked(usePathname).mockReturnValue('/admin/users');
    render(React.createElement(SurfaceSync));
    expect(document.documentElement.dataset.surface).toBe('admin');
  });

  it('marks the html element consumer on a non-admin route', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(React.createElement(SurfaceSync));
    expect(document.documentElement.dataset.surface).toBe('consumer');
  });

  it('updates the attribute when the pathname changes (client-side nav)', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    const { rerender } = render(React.createElement(SurfaceSync));
    expect(document.documentElement.dataset.surface).toBe('consumer');

    vi.mocked(usePathname).mockReturnValue('/admin/users');
    rerender(React.createElement(SurfaceSync));
    expect(document.documentElement.dataset.surface).toBe('admin');
  });

  it('renders nothing', () => {
    vi.mocked(usePathname).mockReturnValue('/');
    const { container } = render(React.createElement(SurfaceSync));
    expect(container.firstChild).toBeNull();
  });
});
