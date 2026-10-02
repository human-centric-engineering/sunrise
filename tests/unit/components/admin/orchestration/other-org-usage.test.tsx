// @vitest-environment happy-dom

/**
 * OtherOrgUsage (§107 t-752): the one line every shared-settings surface
 * uses for agents in other organisations — counted, never named, and absent
 * at zero (always the case on a single-org install).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { agentCount, OtherOrgUsage } from '@/components/admin/orchestration/other-org-usage';

describe('agentCount', () => {
  it('says "agent" for one and "agents" otherwise', () => {
    expect(agentCount(1)).toBe('1 agent');
    expect(agentCount(0)).toBe('0 agents');
    expect(agentCount(4)).toBe('4 agents');
  });
});

describe('OtherOrgUsage', () => {
  it('renders nothing at zero', () => {
    const { container } = render(<OtherOrgUsage count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stands alone when the caller has no agents of its own to list', () => {
    render(<OtherOrgUsage count={1} />);
    expect(
      screen.getByText('1 agent in other organisations uses it. They are counted, not named.')
    ).toBeInTheDocument();
  });

  it('continues a list of the caller’s own agents', () => {
    render(<OtherOrgUsage count={3} afterList className="extra" />);
    const line = screen.getByText(
      '…and 3 agents in other organisations. They are counted, not named.'
    );
    expect(line).toHaveClass('extra');
  });
});
