// @vitest-environment happy-dom

/**
 * OrgPlanForm (§139 t-1093) — a platform admin puts an org on one of the
 * app's plans through `PATCH /api/v1/admin/orgs/[id]/plan`.
 *
 * @see components/admin/orgs/org-plan-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrgPlanForm, type OrgPlanView } from '@/components/admin/orgs/org-plan-form';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';
import { apiClient, APIClientError } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const ORG = 'cmorg000000000000000acme1';
const PATH = `/api/v1/admin/orgs/${ORG}/plan`;

const FREE = {
  key: 'free',
  label: 'Free',
  description: '',
  priced: false,
  switches: { reports: false },
  meterLimits: { seats: 3 },
  aiBudgetUsd: null,
  decidesAiBudget: true,
};
const PRO = {
  key: 'pro',
  label: 'Pro',
  description: 'Reports, and room for a team.',
  priced: true,
  switches: { reports: true, leads: false },
  meterLimits: { seats: 25, convos: null },
  aiBudgetUsd: 100,
  decidesAiBudget: true,
};

function view(overrides: Partial<OrgPlanView> = {}): OrgPlanView {
  return {
    orgId: ORG,
    enabled: true,
    multiTenant: true,
    registrationFailed: false,
    mayChange: true,
    plans: [FREE, PRO],
    fallbackPlanKey: 'free',
    subscription: null,
    ...overrides,
  };
}

function onPlan(planKey: string, planAppliedAt: string | null = '2026-11-20T10:00:00.000Z') {
  return {
    planKey,
    provider: null,
    providerManaged: false,
    status: 'ACTIVE',
    planAppliedAt,
    updatedAt: '2026-11-20T10:00:00.000Z',
  };
}

const save = () => screen.getByRole('button', { name: 'Save plan' });

describe('OrgPlanForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists each plan with what it decides, marking the fallback and paid plans', () => {
    render(<OrgPlanForm orgId={ORG} plan={view()} />);

    expect(screen.getByRole('radio', { name: /No plan/ })).toBeChecked();
    expect(screen.getByTestId('plan-summary-pro')).toHaveTextContent(
      'reports on, leads off · seats 25, convos no limit · AI budget $100'
    );
    expect(screen.getByTestId('plan-summary-free')).toHaveTextContent(
      'reports off · seats 3 · no AI budget cap'
    );
    expect(screen.getByRole('radio', { name: /Free.*fallback/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pro.*paid/ })).toBeInTheDocument();
    // Nothing chosen yet, so there is nothing to save.
    expect(save()).toBeDisabled();
  });

  it('assigns the chosen plan, shows what is stored now, and refreshes the page', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(view({ subscription: onPlan('pro') }));
    render(<OrgPlanForm orgId={ORG} plan={view()} />);

    await user.click(screen.getByRole('radio', { name: /Pro/ }));
    await user.click(save());

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { planKey: 'pro' } });
    expect(await screen.findByText('Plan assigned')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pro.*current/ })).toBeChecked();
    // The Entitlements and Limits sections read what the plan wrote.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(save()).toBeDisabled();
  });

  it('takes the org off its plan with null', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    render(<OrgPlanForm orgId={ORG} plan={view({ subscription: onPlan('pro') })} />);

    await user.click(screen.getByRole('radio', { name: /No plan/ }));
    await user.click(save());

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { planKey: null } });
    expect(await screen.findByText('Plan removed')).toBeInTheDocument();
  });

  it('shows a refused save beside Save, and keeps the choice', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('This organisation pays for its plan through stripe', 'CONFLICT', 409)
    );
    render(<OrgPlanForm orgId={ORG} plan={view()} />);

    await user.click(screen.getByRole('radio', { name: /Pro/ }));
    await user.click(save());

    expect(await screen.findByText(/pays for its plan through stripe/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pro/ })).toBeChecked();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('is read-only from a customer org, saying where to change it', () => {
    render(
      <SharedSettingsAccessProvider readOnly canSwitch>
        <OrgPlanForm orgId={ORG} plan={view({ mayChange: false, subscription: onPlan('free') })} />
      </SharedSettingsAccessProvider>
    );

    expect(screen.getByTestId('shared-settings-read-only')).toHaveTextContent(
      /plan can only be changed from the install organisation/
    );
    expect(screen.getByRole('radio', { name: /Pro/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument();
  });

  it('cannot change a plan a provider subscription decides', () => {
    render(
      <OrgPlanForm
        orgId={ORG}
        plan={view({
          subscription: { ...onPlan('pro'), provider: 'stripe', providerManaged: true },
        })}
      />
    );

    expect(screen.getByText(/pays for its plan through stripe/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Free/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument();
  });

  it('names the provider when it is known, and says "a payment provider" when it is not', () => {
    render(
      <OrgPlanForm
        orgId={ORG}
        plan={view({
          subscription: { ...onPlan('pro'), provider: null, providerManaged: true },
        })}
      />
    );

    expect(screen.getByText(/pays for its plan through a payment provider,/)).toBeInTheDocument();
  });

  it('names a plan the app no longer registers, rather than show nothing chosen', async () => {
    const user = userEvent.setup();
    render(<OrgPlanForm orgId={ORG} plan={view({ subscription: onPlan('legacy') })} />);

    expect(screen.getByText(/which the\s+app no longer registers/)).toHaveTextContent('legacy');
    expect(save()).toBeDisabled();

    // Another plan can still be chosen.
    await user.click(screen.getByRole('radio', { name: /Free/ }));
    expect(save()).toBeEnabled();
  });

  it("says the app's plans failed to register", () => {
    render(
      <OrgPlanForm
        orgId={ORG}
        plan={view({ enabled: false, registrationFailed: true, plans: [] })}
      />
    );

    expect(screen.getByText(/plans could not be registered/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument();
  });
});
