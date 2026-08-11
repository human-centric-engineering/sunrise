/**
 * DatasetCasesTable component tests.
 *
 * Coverage:
 *  - Renders one row per case with position, input summary, expectedOutput
 *  - Object inputs are JSON-stringified for display
 *  - Edit dialog opens with the row's input + expectedOutput prefilled
 *  - Save PATCHes the right endpoint with only-changed fields
 *  - Object inputs render read-only in the dialog (no input textarea)
 *  - Save sends `expectedOutput: null` when the field is cleared
 *  - Server error surfaces inline; dialog stays open
 *  - Empty input blocks save with an inline error
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-cases-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter({ refresh: mockRefresh }),
  };
});

import {
  DatasetCasesTable,
  type DatasetCaseRow,
} from '@/components/admin/orchestration/evaluations-foundations/dataset-cases-table';
import { API } from '@/lib/api/endpoints';

const DATASET_ID = 'cmtest';

function buildRows(): DatasetCaseRow[] {
  return [
    { id: 'c-0', position: 0, input: 'Refund window?', expectedOutput: '30 days.' },
    { id: 'c-1', position: 1, input: 'How to cancel?', expectedOutput: 'Use dashboard.' },
  ];
}

function mockFetchSuccess(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        case: {
          id: 'c-0',
          position: 0,
          input: 'edited input',
          expectedOutput: 'edited expected',
        },
        contentHash: 'new-hash',
      },
    }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DatasetCasesTable', () => {
  it('renders one row per case with position + input + expectedOutput', () => {
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    expect(screen.getByText('Refund window?')).toBeInTheDocument();
    expect(screen.getByText('30 days.')).toBeInTheDocument();
    expect(screen.getByText('How to cancel?')).toBeInTheDocument();
  });

  it('JSON-stringifies object inputs in the row', () => {
    const rows: DatasetCaseRow[] = [
      { id: 'c-0', position: 0, input: { topic: 'refund' }, expectedOutput: null },
    ];
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={rows} />);
    expect(screen.getByText(/"topic":"refund"/)).toBeInTheDocument();
  });

  it('shows an em-dash when expectedOutput is null', () => {
    const rows: DatasetCaseRow[] = [{ id: 'c-0', position: 0, input: 'q', expectedOutput: null }];
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={rows} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('opens the edit dialog prefilled with the row data', async () => {
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));
    await screen.findByText(/Edit case 0/);
    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    expect(inputArea.value).toBe('Refund window?');
    const expectedArea = document.getElementById('edit-expected') as HTMLTextAreaElement;
    expect(expectedArea.value).toBe('30 days.');
  });

  it('Save PATCHes the endpoint with only the fields that changed', async () => {
    const fetchMock = mockFetchSuccess();
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    await user.clear(inputArea);
    await user.type(inputArea, 'new input');

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API.ADMIN.ORCHESTRATION.evalDatasetCaseByPosition(DATASET_ID, 0));
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ input: 'new input' });
    // expectedOutput is unchanged, so it MUST NOT be in the patch.
    expect(body.expectedOutput).toBeUndefined();
  });

  it('Save sends expectedOutput: null when the field is cleared', async () => {
    const fetchMock = mockFetchSuccess();
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const expectedArea = document.getElementById('edit-expected') as HTMLTextAreaElement;
    await user.clear(expectedArea);

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ expectedOutput: null });
  });

  it('blocks save with an inline error when input is empty', async () => {
    mockFetchSuccess();
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    await user.clear(inputArea);

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/Input cannot be empty/i)).toBeInTheDocument();
  });

  it('object inputs render read-only in the dialog (no input textarea)', async () => {
    const rows: DatasetCaseRow[] = [
      { id: 'c-0', position: 0, input: { topic: 'refund' }, expectedOutput: 'a' },
    ];
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={rows} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    expect(document.getElementById('edit-input')).toBeNull();
    expect(screen.getByText(/Object inputs.*aren't editable here/i)).toBeInTheDocument();
  });

  it('surfaces server errors inline and keeps the dialog open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: { message: 'PATCH failed: contentHash drift' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    await user.clear(inputArea);
    await user.type(inputArea, 'new');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/contentHash drift/)).toBeInTheDocument();
    // Dialog stays open
    expect(screen.getByText(/Edit case 0/)).toBeInTheDocument();
  });

  it('closes the dialog without firing fetch when Save is clicked with no changes', async () => {
    // The handler builds a `patch` object from only the fields that changed.
    // If neither input nor expectedOutput differs from the row's current
    // values, the patch is empty and the dialog closes without a network call.
    // This protects against burning a request (and bumping the contentHash)
    // for a no-op edit.
    const fetchMock = mockFetchSuccess();
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));
    await screen.findByText(/Edit case 0/);

    // Don't touch input or expectedOutput — both stay at their initial values.
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(screen.queryByText(/Edit case 0/)).not.toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a network error inline when fetch rejects', async () => {
    // catch-block coverage on line 157: when the fetch promise rejects
    // (e.g. offline / DNS failure / aborted), the error message must be
    // surfaced in the dialog rather than silently swallowed.
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    await user.clear(inputArea);
    await user.type(inputArea, 'new');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/Network unreachable/)).toBeInTheDocument();
    // Dialog stays open so the user can retry.
    expect(screen.getByText(/Edit case 0/)).toBeInTheDocument();
  });

  it('updates local state + calls router.refresh on successful save', async () => {
    mockFetchSuccess();
    const user = userEvent.setup();
    render(<DatasetCasesTable datasetId={DATASET_ID} initialCases={buildRows()} />);
    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));

    const inputArea = document.getElementById('edit-input') as HTMLTextAreaElement;
    await user.clear(inputArea);
    await user.type(inputArea, 'edited input');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    // Row now shows the new input.
    expect(screen.getByText('edited input')).toBeInTheDocument();
  });
});
