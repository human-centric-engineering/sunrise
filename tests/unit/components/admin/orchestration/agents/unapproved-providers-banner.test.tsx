// @vitest-environment happy-dom

/**
 * UnapprovedProvidersBanner (§120 t-745) — an agent stranded by its org's
 * provider policy says why on its edit page.
 *
 * @see components/admin/orchestration/agents/unapproved-providers-banner.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { UnapprovedProvidersBanner } from '@/components/admin/orchestration/agents/unapproved-providers-banner';

describe('UnapprovedProvidersBanner', () => {
  it('renders nothing when the agent names no unapproved provider', () => {
    const { container } = render(
      <UnapprovedProvidersBanner provider="anthropic" unapproved={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says the agent cannot respond when its primary provider is not approved', () => {
    render(<UnapprovedProvidersBanner provider="openai" unapproved={['openai', 'voyage']} />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('This agent cannot respond');
    expect(banner).toHaveTextContent('Primary provider “openai”');
    expect(banner).toHaveTextContent('Fallback provider “voyage”: failover to it is refused');
    expect(banner).toHaveTextContent('Management → Organisations');
  });

  it('names only the refused fallbacks when the primary is approved', () => {
    render(<UnapprovedProvidersBanner provider="anthropic" unapproved={['openai', 'voyage']} />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Some of this agent’s fallback providers are not approved');
    expect(banner).not.toHaveTextContent('cannot respond');
    expect(banner).not.toHaveTextContent('Primary provider');
    expect(banner).toHaveTextContent(
      'Fallback providers “openai”, “voyage”: failover to them is refused'
    );
  });
});
