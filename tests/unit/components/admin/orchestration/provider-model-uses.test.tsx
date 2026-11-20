// @vitest-environment happy-dom

/**
 * ProviderModelUses (§136 t-1065) — the cases the edit-page tests leave out:
 * columns with nothing in them beside one that has something, the counts'
 * wording, and a state without a day.
 *
 * @see components/admin/orchestration/provider-model-uses.tsx
 * @see tests/integration/app/admin/orchestration/provider-models/edit-page.test.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import {
  modelHasUses,
  ProviderModelUses,
  type ProviderModelUsesData,
} from '@/components/admin/orchestration/provider-model-uses';

const NONE: ProviderModelUsesData = {
  agents: [],
  workflows: [],
  otherOrgAgents: 0,
  otherOrgAgentsFollowingPlatform: 0,
  otherOrgWorkflows: 0,
  otherOrgWorkflowsByIdOnly: 0,
  settings: [],
  sharedWith: [],
};

function panel(uses: Partial<ProviderModelUsesData>, retiresAt: string | null = null) {
  render(
    <ProviderModelUses
      retiresAt={retiresAt}
      lifecycle={{ state: retiresAt ? 'retiring' : 'current', replacement: null }}
      uses={{ ...NONE, ...uses }}
    />
  );
  return screen.getByRole('region', { name: 'Retirement and uses' });
}

function column(region: HTMLElement, name: string): HTMLElement {
  const heading = within(region).getByRole('heading', { name });
  const parent = heading.parentElement;
  if (!parent) throw new Error(`${name} column not rendered`);
  return parent;
}

describe('ProviderModelUses', () => {
  it('says None in each empty column beside one that has a use', () => {
    const region = panel({ workflows: [{ id: 'w1', name: 'Triage', byIdOnly: false }] });

    expect(column(region, 'Agents')).toHaveTextContent('None');
    expect(column(region, 'Settings')).toHaveTextContent('None');
    expect(column(region, 'Workflows')).not.toHaveTextContent('None');
  });

  it('counts other orgs alone, in the singular, without a platform clause when none follow it', () => {
    const region = panel({ otherOrgAgents: 1, otherOrgWorkflows: 2 });

    const agents = column(region, 'Agents');
    expect(agents).toHaveTextContent(
      '1 agent in other organisations. They are counted, not named.'
    );
    expect(agents).not.toHaveTextContent('None');
    expect(agents).not.toHaveTextContent('following the platform');
    expect(column(region, 'Workflows')).toHaveTextContent('2 workflows in other organisations');
  });

  it('shows no badge and no replacement line for a model with no retirement', () => {
    const region = panel({ settings: [{ slot: 'chat', source: 'saved' }] });

    expect(region).not.toHaveTextContent(/Retir(ing|ed) on/);
    expect(region).not.toHaveTextContent('Replacement');
    expect(column(region, 'Settings')).toHaveTextContent('Default model for chat');
    expect(column(region, 'Settings')).not.toHaveTextContent('suggestion');
  });

  it('shows the replacement line but no badge when a dated state arrives without its day', () => {
    render(
      <ProviderModelUses
        retiresAt={null}
        lifecycle={{ state: 'retired', replacement: null }}
        uses={NONE}
      />
    );
    const region = screen.getByRole('region', { name: 'Retirement and uses' });

    expect(region).not.toHaveTextContent('Retired on');
    expect(region).toHaveTextContent('No replacement named yet.');
    expect(region).toHaveTextContent('Nothing uses this model.');
  });

  it.each([
    ['turned off', { isActive: false, retiresAt: null }, 'It has been turned off'],
    [
      'itself retiring',
      { isActive: true, retiresAt: '2099-01-01T00:00:00.000Z' },
      'It is itself being retired',
    ],
  ])('says when the stored replacement has been %s', (_label, state, message) => {
    render(
      <ProviderModelUses
        retiresAt="2098-01-01T00:00:00.000Z"
        lifecycle={{
          state: 'retiring',
          replacement: { id: 'm2', name: 'GPT-5', modelId: 'gpt-5', ...state },
        }}
        uses={NONE}
      />
    );
    const region = screen.getByRole('region', { name: 'Retirement and uses' });

    expect(region).toHaveTextContent(`${message}: choose another before moving anything to it.`);
  });

  it('adds no note for a replacement that still qualifies', () => {
    render(
      <ProviderModelUses
        retiresAt="2098-01-01T00:00:00.000Z"
        lifecycle={{
          state: 'retiring',
          replacement: {
            id: 'm2',
            name: 'GPT-5',
            modelId: 'gpt-5',
            isActive: true,
            retiresAt: null,
          },
        }}
        uses={NONE}
      />
    );

    expect(screen.getByRole('region', { name: 'Retirement and uses' })).not.toHaveTextContent(
      'choose another'
    );
  });

  it('says when a use names the model by id alone and another provider offers the id', () => {
    const region = panel({
      workflows: [
        { id: 'w1', name: 'Triage', byIdOnly: true },
        { id: 'w2', name: 'Intake', byIdOnly: false },
      ],
      otherOrgWorkflows: 3,
      otherOrgWorkflowsByIdOnly: 2,
      settings: [{ slot: 'chat', source: 'saved', byIdOnly: true }],
      sharedWith: ['microsoft'],
    });

    expect(region).toHaveTextContent('Default model for chat*');
    // Only the workflow pinning the id alone is marked.
    expect(column(region, 'Workflows')).toHaveTextContent('Triage*');
    expect(column(region, 'Workflows')).not.toHaveTextContent('Intake*');
    expect(column(region, 'Workflows')).toHaveTextContent(
      '3 workflows in other organisations (2 by model id alone). They are counted, not named.'
    );
    expect(region).toHaveTextContent(
      "The uses marked * name this model by its id alone, with no provider, which microsoft also offers. They may run on that provider's model instead"
    );
  });

  it('says nothing about shared ids when every use names the provider (§136 t-1068)', () => {
    const region = panel({
      workflows: [{ id: 'w1', name: 'Triage', byIdOnly: false }],
      otherOrgWorkflows: 1,
      settings: [{ slot: 'chat', source: 'saved' }],
      sharedWith: ['microsoft'],
    });

    expect(region).not.toHaveTextContent('by its id alone');
    expect(region).not.toHaveTextContent('*');
    expect(column(region, 'Workflows')).not.toHaveTextContent('by model id alone');
  });

  it("says nothing about shared ids when the id is the model's alone", () => {
    const region = panel({
      workflows: [{ id: 'w1', name: 'Triage', byIdOnly: true }],
      settings: [{ slot: 'chat', source: 'saved', byIdOnly: true }],
    });

    expect(region).not.toHaveTextContent('by its id alone');
    expect(region).not.toHaveTextContent('chat*');
  });
});

describe('the move action (§136 t-1066)', () => {
  function withAction(uses: Partial<ProviderModelUsesData>) {
    render(
      <ProviderModelUses
        retiresAt={null}
        lifecycle={{ state: 'current', replacement: null }}
        uses={{ ...NONE, ...uses }}
        action={<button type="button">Move uses…</button>}
      />
    );
  }

  it('is rendered beside the heading whatever the uses, so an open dialog outlives a refresh', () => {
    withAction({});
    expect(screen.getByRole('button', { name: 'Move uses…' })).toBeInTheDocument();
  });

  it('modelHasUses counts agents, workflows (any org) and settings', () => {
    expect(modelHasUses(NONE)).toBe(false);
    expect(modelHasUses({ ...NONE, otherOrgWorkflows: 1 })).toBe(true);
    expect(modelHasUses({ ...NONE, otherOrgAgents: 1 })).toBe(true);
    expect(modelHasUses({ ...NONE, settings: [{ slot: 'chat', source: 'suggested' }] })).toBe(true);
  });
});

describe('the app’s own uses (§136 t-1067)', () => {
  it('shows nothing about the app when it reports nothing', () => {
    const region = panel({ agents: [{ id: 'a1', name: 'Helper', followsPlatform: false }] });
    expect(within(region).queryByRole('heading', { name: 'In the app' })).not.toBeInTheDocument();
  });

  it('names the caller’s, counts other orgs’, and says the move leaves them to the app', () => {
    const region = panel({
      appPins: [{ label: 'Panel: Contracts', where: 'Panels › Contracts › Judge' }],
      otherOrgAppPins: 3,
    });

    const app = column(region, 'In the app');
    expect(app).toHaveTextContent('Panel: Contracts');
    expect(app).toHaveTextContent('Panels › Contracts › Judge');
    expect(app).toHaveTextContent('3 in other organisations. They are counted, not named.');
    expect(app).toHaveTextContent('moving the model’s uses does not change them');
    expect(region).not.toHaveTextContent('Nothing uses this model.');
  });

  it('says when the app’s uses could not all be read', () => {
    const region = panel({ appPinsUnavailable: true });
    expect(column(region, 'In the app')).toHaveTextContent(
      'The app’s own uses could not all be read, so there may be more.'
    );
  });

  it('modelHasUses counts the app’s uses, in any org', () => {
    expect(modelHasUses({ ...NONE, appPins: [{ label: 'P', where: 'w' }] })).toBe(true);
    expect(modelHasUses({ ...NONE, otherOrgAppPins: 1 })).toBe(true);
    expect(modelHasUses({ ...NONE, appPins: [], otherOrgAppPins: 0 })).toBe(false);
  });
});
