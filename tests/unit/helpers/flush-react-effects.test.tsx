// @vitest-environment happy-dom

/**
 * The race behind t-995: `findBy…` can resolve in the gap between a commit and
 * its passive effects, so an assertion on what those effects did fails at
 * random. `tests/setup.ts` closes the gap for every test, a fork's included.
 *
 * @see tests/setup.ts · tests/helpers/flush-react-effects.ts
 */

import { useEffect, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { reactEffects } from '@/tests/helpers/flush-react-effects';

const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe('reactEffects.flush', () => {
  it('runs a commit’s passive effects before React gets to them', async () => {
    const ran: string[] = [];
    let show = (_: boolean) => {};
    function Late() {
      const [on, setOn] = useState(false);
      show = setOn;
      useEffect(() => {
        if (on) ran.push('effect');
      }, [on]);
      return on ? <p>Shown</p> : null;
    }
    render(<Late />);

    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // The observer fires between the commit and its passive effects: the
      // gap a `findBy…` resolves in.
      const seen = await new Promise<{ before: string[]; after: string[] }>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          try {
            const before = [...ran];
            reactEffects.flush();
            resolve({ before, after: [...ran] });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        show(true);
      });

      expect(screen.getByText('Shown')).toBeInTheDocument();
      expect(seen).toEqual({ before: [], after: ['effect'] });
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it('logs nothing when a query runs inside act()', async () => {
    const error = vi.spyOn(console, 'error');
    render(<button type="button">Press</button>);

    await act(async () => {
      await screen.findByRole('button');
    });

    expect(error).not.toHaveBeenCalled();
  });
});

describe('tests/setup.ts', () => {
  it('flushes effects after a findBy query', async () => {
    render(<p>Here</p>);
    const flush = vi.spyOn(reactEffects, 'flush');

    await screen.findByText('Here');

    expect(flush).toHaveBeenCalled();
  });

  it('flushes effects after a query that fails', async () => {
    const flush = vi.spyOn(reactEffects, 'flush');

    await expect(waitFor(() => screen.getByText('Absent'), { timeout: 10 })).rejects.toThrow();

    expect(flush).toHaveBeenCalled();
  });

  it('flushes effects after a user-event call', async () => {
    render(<button type="button">Press</button>);
    const user = userEvent.setup();
    const flush = vi.spyOn(reactEffects, 'flush');

    await user.click(screen.getByRole('button'));

    expect(flush).toHaveBeenCalled();
  });

  describe('hook order', () => {
    // Importing Testing Library's main entry from setup registers its cleanup
    // before setup's own `restoreAllMocks`, so spies would be restored before
    // components unmount, in every DOM test. Cleanup runs after the first of
    // these, and the second reads what it saw.
    const seenOnUnmount: string[] = [];

    it('leaves a component mounted that reads a spy on unmount', () => {
      const target = { read: () => 'real' };
      vi.spyOn(target, 'read').mockReturnValue('mocked');
      function Reads() {
        useEffect(() => () => void seenOnUnmount.push(target.read()), []);
        return null;
      }

      render(<Reads />);
    });

    it('unmounted it while the spy was still in place', () => {
      expect(seenOnUnmount).toEqual(['mocked']);
    });
  });
});
