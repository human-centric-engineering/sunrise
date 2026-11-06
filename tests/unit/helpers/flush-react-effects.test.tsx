// @vitest-environment happy-dom

/**
 * The race behind t-995: `findBy…` can resolve in the gap between a commit and
 * its passive effects, so an assertion on what those effects did fails at
 * random. `tests/setup.ts` closes the gap for every test, a fork's included.
 *
 * @see tests/setup.ts · tests/helpers/flush-react-effects.ts
 */

import { useEffect, useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getConfig, render, screen } from '@testing-library/react';

import { reactEffects } from '@/tests/helpers/flush-react-effects';

const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

afterEach(() => {
  vi.restoreAllMocks();
});

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
    // The observer fires between the commit and its passive effects: the gap
    // a `findBy…` resolves in.
    const seen = await new Promise<{ before: string[]; after: string[] }>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const before = [...ran];
        reactEffects.flush();
        resolve({ before, after: [...ran] });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      show(true);
    });
    environment.IS_REACT_ACT_ENVIRONMENT = previous;

    expect(screen.getByText('Shown')).toBeInTheDocument();
    expect(seen).toEqual({ before: [], after: ['effect'] });
  });
});

describe('tests/setup.ts', () => {
  it('flushes effects at the end of every async query', async () => {
    const flush = vi.spyOn(reactEffects, 'flush');

    await getConfig().asyncWrapper(async () => undefined);

    expect(flush).toHaveBeenCalledOnce();
  });
});
