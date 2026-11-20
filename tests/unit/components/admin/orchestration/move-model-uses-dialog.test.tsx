// @vitest-environment happy-dom

/**
 * MoveModelUsesDialog (§136 t-1066): the preview for the chosen replacement,
 * the move, and what it reports, org by org.
 *
 * @see components/admin/orchestration/move-model-uses-dialog.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

// The real APIClientError, so the dialog reads a failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';
import {
  MoveModelUsesDialog,
  type MovePreview,
  type MoveResult,
} from '@/components/admin/orchestration/move-model-uses-dialog';

const OPTIONS = [
  { id: 'm-new', name: 'GPT-4.1', modelId: 'gpt-4.1' },
  { id: 'm-alt', name: 'GPT-4.1 mini', modelId: 'gpt-4.1-mini' },
];

const PREVIEW: MovePreview = {
  replacement: { id: 'm-new', name: 'GPT-4.1', modelId: 'gpt-4.1' },
  orgs: [
    {
      orgId: 'org-a',
      name: 'Acme',
      agents: 2,
      inactiveAgents: 1,
      agentsFollowingPlatform: 1,
      workflows: 1,
      left: { chat_turn_by_id: 1 },
      ownKey: false,
    },
    {
      orgId: 'org-b',
      name: 'Bolt',
      agents: 1,
      inactiveAgents: 0,
      agentsFollowingPlatform: 0,
      workflows: 0,
      left: {},
      ownKey: true,
    },
  ],
  settings: {
    moved: [{ slot: 'chat', from: 'gpt-4o', to: 'openai::gpt-4.1', source: 'suggested' }],
    left: [{ slot: 'embeddings', reason: 'embedding_switch' }],
  },
  suspendedOrgs: 1,
};

const RESULT: MoveResult = {
  replacement: PREVIEW.replacement,
  orgs: [
    {
      orgId: 'org-a',
      name: 'Acme',
      status: 'moved',
      agents: 2,
      workflows: 1,
      left: {},
      agentsFollowingPlatform: 0,
    },
    {
      orgId: 'org-b',
      name: 'Bolt',
      status: 'skipped',
      reason: 'The provider refused its own key for this provider.',
      agents: 0,
      workflows: 0,
      left: {},
      agentsFollowingPlatform: 0,
    },
    {
      orgId: 'org-c',
      name: 'Cove',
      status: 'left',
      agents: 0,
      workflows: 0,
      left: { published_invalid: 1 },
      agentsFollowingPlatform: 0,
    },
  ],
  settings: { moved: PREVIEW.settings.moved, left: [] },
  suspendedOrgs: 1,
  totals: { agents: 2, workflows: 1, settings: 1, skipped: 1, failed: 0 },
};

function renderDialog(props: Partial<Parameters<typeof MoveModelUsesDialog>[0]> = {}) {
  return render(
    <MoveModelUsesDialog
      modelId="m-old"
      modelName="GPT-4o"
      replacementOptions={OPTIONS}
      replacementId="m-new"
      hasUses
      {...props}
    />
  );
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Move uses…' }));
  return { user, dialog: await screen.findByRole('dialog') };
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('MoveModelUsesDialog', () => {
  it('previews the stored replacement on open: each org’s counts, its key, what is left', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(PREVIEW);
    renderDialog();
    const { dialog } = await open();

    await within(dialog).findByText('Acme');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/v1/admin/orchestration/provider-models/m-old/move-uses/preview',
      { body: { replacementId: 'm-new' } }
    );
    expect(dialog).toHaveTextContent('Acme: 2 agents (1 turned off), 1 workflow');
    expect(dialog).toHaveTextContent('Bolt: 1 agent, 0 workflows');
    expect(dialog).toHaveTextContent(
      'Uses its own key for this provider. The key is sent one short test message to GPT-4.1 first'
    );
    expect(dialog).toHaveTextContent('1 workflow step left: A chat-turn step');
    expect(dialog).toHaveTextContent(
      '1 agent left: Sunrise picks its model, and moves it off a retiring model on its own.'
    );
    expect(dialog).toHaveTextContent(
      "Default model for chat: moves (the system's suggestion, saved as the replacement)"
    );
    expect(dialog).toHaveTextContent('Default model for embeddings: left');
    expect(dialog).toHaveTextContent('1 suspended organisation not looked at');
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeEnabled();
  });

  it('previews again when another replacement is chosen', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(PREVIEW);
    renderDialog();
    const { user, dialog } = await open();
    await within(dialog).findByText('Acme');

    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'GPT-4.1 mini (gpt-4.1-mini)' }));

    expect(apiClient.post).toHaveBeenLastCalledWith(
      '/api/v1/admin/orchestration/provider-models/m-old/move-uses/preview',
      { body: { replacementId: 'm-alt' } }
    );
  });

  it('shows only the newest preview when an earlier one answers late', async () => {
    let answerFirst: (value: MovePreview) => void = () => {};
    vi.mocked(apiClient.post)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ...PREVIEW,
        replacement: { id: 'm-alt', name: 'GPT-4.1 mini', modelId: 'gpt-4.1-mini' },
        orgs: [{ ...PREVIEW.orgs[1], name: 'Only B' }],
      });
    renderDialog();
    const { user, dialog } = await open();

    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'GPT-4.1 mini (gpt-4.1-mini)' }));
    await within(dialog).findByText('Only B');

    // The first replacement's preview arrives after: it is not shown.
    answerFirst(PREVIEW);
    await new Promise((r) => setTimeout(r, 0));
    expect(within(dialog).queryByText('Acme')).toBeNull();
    expect(within(dialog).getByText('Only B')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeEnabled();
  });

  it('moves, then reports every org’s outcome and refreshes the page', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(RESULT);
    renderDialog();
    const { user, dialog } = await open();
    await within(dialog).findByText('Acme');

    await user.click(within(dialog).getByRole('button', { name: 'Move uses' }));

    const status = await within(dialog).findByRole('status');
    expect(apiClient.post).toHaveBeenLastCalledWith(
      '/api/v1/admin/orchestration/provider-models/m-old/move-uses',
      { body: { replacementId: 'm-new' } }
    );
    expect(status).toHaveTextContent(
      'Moved 2 agents, 1 workflow and 1 setting to GPT-4.1. 1 organisation skipped.'
    );
    expect(status).toHaveTextContent('Acme: Moved (2 agents, 1 workflow)');
    expect(status).toHaveTextContent(
      'Bolt: SkippedThe provider refused its own key for this provider.'
    );
    expect(status).toHaveTextContent(
      'Cove: Nothing moved1 workflow left: Its published version no longer passes the workflow checks'
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows a refused move beside its button, and keeps the dialog open', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce(PREVIEW)
      .mockRejectedValueOnce(
        new APIClientError('"GPT-4.1" is itself being retired', 'VALIDATION_ERROR', 400)
      );
    renderDialog();
    const { user, dialog } = await open();
    await within(dialog).findByText('Acme');

    await user.click(within(dialog).getByRole('button', { name: 'Move uses' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '"GPT-4.1" is itself being retired'
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says why the preview failed, and offers no move', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('The replacement must be on the same provider', 'VALIDATION_ERROR', 400)
    );
    renderDialog();
    const { dialog } = await open();

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Couldn’t preview the move: The replacement must be on the same provider'
    );
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeDisabled();
  });

  it('offers no move when nothing would move', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      ...PREVIEW,
      orgs: [{ ...PREVIEW.orgs[0], agents: 0, workflows: 0 }],
      settings: { moved: [], left: [] },
    });
    renderDialog();
    const { dialog } = await open();
    await within(dialog).findByText('Acme');
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeDisabled();
  });

  it('keeps showing the result after the page refreshes to nothing using the model', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(RESULT);
    const { rerender } = renderDialog();
    const { user, dialog } = await open();
    await within(dialog).findByText('Acme');
    await user.click(within(dialog).getByRole('button', { name: 'Move uses' }));
    await within(dialog).findByRole('status');

    // The refresh the move asks for: nothing uses the model now.
    rerender(
      <MoveModelUsesDialog
        modelId="m-old"
        modelName="GPT-4o"
        replacementOptions={OPTIONS}
        replacementId="m-new"
        hasUses={false}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Moved 2 agents');

    // Closed, it offers nothing more to move.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: 'Move uses…' })).toBeNull();
  });

  it('is not offered where shared settings are read-only, with no model to move to, or with nothing to move', () => {
    const { unmount } = render(
      <SharedSettingsAccessProvider readOnly canSwitch={false}>
        <MoveModelUsesDialog
          modelId="m-old"
          modelName="GPT-4o"
          replacementOptions={OPTIONS}
          replacementId="m-new"
          hasUses
        />
      </SharedSettingsAccessProvider>
    );
    expect(screen.queryByRole('button', { name: 'Move uses…' })).toBeNull();
    unmount();
    renderDialog({ replacementOptions: [] }).unmount();
    expect(screen.queryByRole('button', { name: 'Move uses…' })).toBeNull();
    renderDialog({ hasUses: false });
    expect(screen.queryByRole('button', { name: 'Move uses…' })).toBeNull();
  });
});

describe('the app’s own pins and its check (§136 t-1067)', () => {
  it('counts the app’s pins in an org, and says the app moves them itself', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      ...PREVIEW,
      orgs: [{ ...PREVIEW.orgs[0], appPins: 2 }, PREVIEW.orgs[1]],
      app: { pinsUnavailable: false, refused: null },
    });
    renderDialog();
    const { dialog } = await open();
    await within(dialog).findByText('Acme');

    expect(dialog).toHaveTextContent(
      '2 uses the app reports: the app moves them itself, not this move.'
    );
    expect(dialog).not.toHaveTextContent('The app refuses this move');
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeEnabled();
  });

  it('shows the app’s refusal and offers no move', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      ...PREVIEW,
      app: { pinsUnavailable: true, refused: 'GPT-4.1 failed the contract panel' },
    });
    renderDialog();
    const { dialog } = await open();
    await within(dialog).findByText('Acme');

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The app refuses this moveGPT-4.1 failed the contract panel'
    );
    expect(dialog).toHaveTextContent('could not all be read, so they may be undercounted here');
    expect(within(dialog).getByRole('button', { name: 'Move uses' })).toBeDisabled();
  });

  it('shows a refusal the move itself met, beside its button', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce(PREVIEW)
      .mockRejectedValueOnce(
        new APIClientError('GPT-4.1 failed the contract panel', 'CONFLICT', 409)
      );
    renderDialog();
    const { user, dialog } = await open();
    await within(dialog).findByText('Acme');

    await user.click(within(dialog).getByRole('button', { name: 'Move uses' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'GPT-4.1 failed the contract panel'
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
