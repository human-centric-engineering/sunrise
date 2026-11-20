// @vitest-environment happy-dom

/**
 * ErrorBoundary: catches a render error, logs it, shows a fallback (its own
 * from the catalogue, or the caller's), and recovers on "Try again" or when
 * a reset key changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/lib/i18n/messages/en.json';
import { ErrorBoundary } from '@/components/error-boundary';
import { logger } from '@/lib/logging';

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const state = vi.hoisted(() => ({ broken: true }));

function Child() {
  if (state.broken) throw new Error('kaboom');
  return <p>child content</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    state.broken = true;
    vi.mocked(logger.error).mockClear();
    // React reports a caught render error to the console; keep the output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders its children when nothing throws', () => {
    state.broken = false;
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );

    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('shows the default fallback from the catalogue and logs the error', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary errorBoundaryName="widgets" onError={onError}>
        <Child />
      </ErrorBoundary>
    );

    expect(screen.getByText(en.errors.generic.title)).toBeInTheDocument();
    expect(screen.getByText(en.errors.generic.description)).toBeInTheDocument();
    expect(screen.queryByText('kaboom')).not.toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'Error caught by boundary',
      expect.objectContaining({ message: 'kaboom' }),
      expect.objectContaining({ boundaryName: 'widgets', errorType: 'boundary' })
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'kaboom' }),
      expect.anything()
    );
  });

  it('shows the error message in development only', () => {
    vi.stubEnv('NODE_ENV', 'development');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );

    expect(screen.getByText('kaboom')).toBeInTheDocument();
  });

  it('renders the children again after "Try again"', async () => {
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );

    state.broken = false;
    await userEvent.click(screen.getByRole('button', { name: en.errors.generic.tryAgain }));

    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('uses a fallback element or render function the caller gives', () => {
    const { unmount } = render(
      <ErrorBoundary fallback={<p>custom fallback</p>}>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
    unmount();

    render(
      <ErrorBoundary fallback={(error) => <p>failed: {error.message}</p>}>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText('failed: kaboom')).toBeInTheDocument();
  });

  it('resets when a reset key changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['a']}>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText(en.errors.generic.title)).toBeInTheDocument();

    state.broken = false;
    rerender(
      <ErrorBoundary resetKeys={['a']}>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText(en.errors.generic.title)).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKeys={['b']}>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});
