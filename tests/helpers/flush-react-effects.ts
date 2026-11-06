import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
// `/pure`: the main entry registers its cleanup hook on import, and from
// tests/setup.ts that would run after spies are restored, not before.
import { act } from '@testing-library/react/pure';

// Made now, not on first use, so it can't land inside a test's `createElement` spy.
const root = createRoot(document.createElement('div'));

/** An object, so a test can spy on the call `tests/setup.ts` makes. */
export const reactEffects = {
  /**
   * Runs React's pending passive effects now. Sync work on any root flushes
   * them first, and they are global to React, so a throwaway root is enough.
   */
  flush(): void {
    act(() => {
      flushSync(() => root.render(null));
    });
  },
};
