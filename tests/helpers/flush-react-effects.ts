import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

let root: Root | null = null;

/** An object, so a test can spy on the call `tests/setup.ts` makes. */
export const reactEffects = {
  /**
   * Runs React's pending passive effects now. Sync work on any root flushes
   * them first, and they are global to React, so a throwaway root is enough.
   */
  flush(): void {
    root ??= createRoot(document.createElement('div'));
    const scratch = root;
    flushSync(() => scratch.render(null));
  },
};
