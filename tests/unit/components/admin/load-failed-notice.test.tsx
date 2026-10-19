// @vitest-environment happy-dom

/**
 * Tests: LoadFailedNotice — what a panel shows when its data failed to load
 *
 * It must read as a failure (an alert naming what failed), never as an empty
 * state, and "Try again" must re-run the page's server fetches.
 *
 * @see components/admin/load-failed-notice.tsx
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { createMockRouter } from '@/tests/types/mocks';

describe('LoadFailedNotice', () => {
  it('announces the failure as an alert naming what failed', () => {
    render(<LoadFailedNotice what="recent executions" />);

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load recent executions.");
  });

  it('refreshes the route when "Try again" is clicked', async () => {
    const router = createMockRouter();
    vi.mocked(useRouter).mockReturnValue(router);

    render(<LoadFailedNotice what="providers" />);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
