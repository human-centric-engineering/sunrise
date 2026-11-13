// @vitest-environment happy-dom

/**
 * ConfigHealthBanner — presentational tests (card + global variants).
 *
 * @see components/admin/config-health-banner.tsx
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, within, cleanup } from '@testing-library/react';

import { ConfigHealthBanner } from '@/components/admin/config-health-banner';
import type { ConfigHealthReport, EvaluatedConfigCheck } from '@/lib/config-health/types';

afterEach(() => cleanup());

function evaluated(overrides: Partial<EvaluatedConfigCheck> = {}): EvaluatedConfigCheck {
  return {
    key: 'CRON_SECRET',
    label: 'Maintenance cron secret',
    severity: 'critical',
    description: 'Background jobs never run.',
    remediation: 'Set CRON_SECRET and redeploy.',
    present: false,
    applicable: true,
    ...overrides,
  };
}

function report(checks: EvaluatedConfigCheck[]): ConfigHealthReport {
  const unmet = checks.filter((c) => c.applicable && !c.present);
  return {
    environment: 'production',
    platform: 'vercel',
    checks,
    summary: {
      critical: unmet.filter((c) => c.severity === 'critical').length,
      warning: unmet.filter((c) => c.severity === 'warning').length,
      info: unmet.filter((c) => c.severity === 'info').length,
      ok: checks.filter((c) => c.applicable && c.present).length,
    },
  };
}

describe('ConfigHealthBanner', () => {
  it('renders nothing when the report is null', () => {
    const { container } = render(<ConfigHealthBanner report={null} variant="card" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every applicable check is satisfied', () => {
    const { container } = render(
      <ConfigHealthBanner
        report={report([evaluated({ present: true }), evaluated({ key: 'email', present: true })])}
        variant="card"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('card variant lists each unmet check with its remediation', () => {
    const { container } = render(
      <ConfigHealthBanner
        report={report([
          evaluated(),
          evaluated({ key: 'email', severity: 'warning', label: 'Transactional email' }),
        ])}
        variant="card"
      />
    );
    const scoped = within(container);
    expect(scoped.getByText('Maintenance cron secret')).toBeInTheDocument();
    expect(scoped.getByText('Transactional email')).toBeInTheDocument();
    // Remediation text is split by the "Fix:" label span — assert on the container's text content.
    expect(container).toHaveTextContent('Set CRON_SECRET and redeploy');
    expect(scoped.getByText('Critical')).toBeInTheDocument();
    expect(scoped.getByText('Warning')).toBeInTheDocument();
  });

  it('card variant ignores checks that are not applicable', () => {
    const { container } = render(
      <ConfigHealthBanner
        report={report([evaluated({ applicable: false, present: true })])}
        variant="card"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('global variant shows critical-only and nothing for warning-only', () => {
    // Only a warning unmet → global banner stays silent.
    const warnOnly = render(
      <ConfigHealthBanner
        report={report([evaluated({ key: 'email', severity: 'warning', label: 'Email' })])}
        variant="global"
      />
    );
    expect(warnOnly.container).toBeEmptyDOMElement();
    cleanup();

    // A critical unmet → global banner appears as an alert.
    const withCritical = render(
      <ConfigHealthBanner report={report([evaluated()])} variant="global" />
    );
    expect(within(withCritical.container).getByRole('alert')).toHaveTextContent(
      /Configuration required/i
    );
    cleanup();

    // Multiple criticals → count + comma-joined label list (the plural summary branch).
    const withTwo = render(
      <ConfigHealthBanner
        report={report([
          evaluated({ key: 'CRON_SECRET', label: 'Cron secret' }),
          evaluated({ key: 'llm_provider', label: 'LLM provider' }),
        ])}
        variant="global"
      />
    );
    expect(within(withTwo.container).getByRole('alert')).toHaveTextContent(
      /2 critical settings \(Cron secret, LLM provider\)/i
    );
  });
});
