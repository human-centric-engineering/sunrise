// @vitest-environment happy-dom

/**
 * Tests for `components/admin/orchestration/stale-save-notice.tsx` (§122 t-899).
 *
 * @see components/admin/orchestration/stale-save-notice.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StaleSaveNotice } from '@/components/admin/orchestration/stale-save-notice';

describe('StaleSaveNotice', () => {
  it('says what changed, that nothing was saved, and that the edits are still on the page', () => {
    render(<StaleSaveNotice what="The escalation list" />);

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('The escalation list changed since you opened it.');
    expect(notice).toHaveTextContent('Nothing was saved.');
    expect(notice).toHaveTextContent(/had their data erased/);
    expect(notice).toHaveTextContent(/your changes are still here/i);
  });

  it('calls onReload instead of reloading the page when given one', async () => {
    const onReload = vi.fn();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(<StaleSaveNotice what="That schedule" onReload={onReload} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /reload/i }));

    expect(onReload).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page, only when asked, when given no onReload', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(<StaleSaveNotice what="This subscription" />);
    expect(reload).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: /reload/i }));

    expect(reload).toHaveBeenCalledOnce();
  });
});
