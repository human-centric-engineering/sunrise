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

  it('offers no copy when the page cannot copy its edits', () => {
    render(<StaleSaveNotice what="This subscription" />);
    expect(screen.queryByRole('button', { name: /copy my changes/i })).not.toBeInTheDocument();
  });

  it('offers to copy the edits first, says a reload discards them, and copies without reloading (t-900)', async () => {
    const onCopyChanges = vi.fn(async () => undefined);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(<StaleSaveNotice what="This workflow" onCopyChanges={onCopyChanges} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/reloading discards them/);

    await userEvent.setup().click(screen.getByRole('button', { name: /copy my changes/i }));

    expect(onCopyChanges).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument();
  });

  it('says so when the copy did not land, rather than "Copied"', async () => {
    const onCopyChanges = vi.fn(async () => {
      throw new Error('clipboard denied');
    });
    render(<StaleSaveNotice what="This workflow" onCopyChanges={onCopyChanges} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /copy my changes/i }));

    expect(await screen.findByRole('button', { name: /copy failed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^copied$/i })).not.toBeInTheDocument();
  });

  it('reports a copier that throws before it has a promise (no clipboard)', async () => {
    const onCopyChanges = vi.fn((): Promise<void> => {
      throw new TypeError("Cannot read properties of undefined (reading 'writeText')");
    });
    render(<StaleSaveNotice what="This workflow" onCopyChanges={onCopyChanges} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /copy my changes/i }));

    expect(await screen.findByRole('button', { name: /copy failed/i })).toBeInTheDocument();
  });

  it('stops saying "Copied" once the edits change (a new copier)', async () => {
    const first = vi.fn(async () => undefined);
    const { rerender } = render(<StaleSaveNotice what="This workflow" onCopyChanges={first} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /copy my changes/i }));
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument();

    rerender(<StaleSaveNotice what="This workflow" onCopyChanges={vi.fn(async () => undefined)} />);

    expect(screen.getByRole('button', { name: /copy my changes/i })).toBeInTheDocument();
  });
});
