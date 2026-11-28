/**
 * UsageNoticeEmail — unit tests (§139 t-1097)
 *
 * Rendered to HTML via @react-email/render. Pins what the template does with
 * its props: which threshold it names, the count against the allowance, AI
 * spend in dollars rather than cents, and the link to the billing page.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { UsageNoticeEmail } from '@/emails/usage-notice';

const base = {
  orgName: 'Acme Ltd',
  meterLabel: 'Conversations',
  threshold: 'near' as const,
  used: 820,
  allowance: 1000,
  money: false,
  billingUrl: 'https://app.example.com/admin/billing',
};

describe('UsageNoticeEmail', () => {
  it('says the item is nearly at its allowance, with the count against it', async () => {
    const html = await render(<UsageNoticeEmail {...base} />);

    expect(html).toContain('Nearly at the allowance: Conversations');
    expect(html).toContain('Acme Ltd has used 820 of the 1,000 included');
    expect(html).toContain('Nothing has been stopped');
    expect(html).toContain('href="https://app.example.com/admin/billing"');
  });

  it('says the allowance is reached at the second threshold', async () => {
    const html = await render(<UsageNoticeEmail {...base} threshold="reached" used={1000} />);

    expect(html).toContain('Allowance reached: Conversations');
    expect(html).not.toContain('Nearly at the allowance');
  });

  it('shows AI spend, counted in cents, as dollars', async () => {
    const html = await render(
      <UsageNoticeEmail {...base} meterLabel="AI spend" money used={4250} allowance={5000} />
    );

    expect(html).toContain('$42.50');
    expect(html).toContain('$50.00');
    expect(html).not.toContain('4,250');
  });
});
