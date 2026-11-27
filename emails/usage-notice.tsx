import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { DEFAULT_EMAIL_LOCALE, emailTranslator } from '@/lib/email/translate';

/**
 * The platform's default notice for a metered item whose overage rule is
 * `warn` (§139 t-1097): sent to each of the org's owners when usage passes
 * the item's threshold, and again at its allowance. Nothing is stopped. An
 * app that tells its orgs some other way sets its own handler
 * (`setUsageNoticeHandler()`, `lib/billing/overage.ts`).
 */
export interface UsageNoticeEmailProps {
  orgName: string;
  /** The meter's label, as the billing page shows it. */
  meterLabel: string;
  threshold: 'near' | 'reached';
  used: number;
  allowance: number;
  /** AI spend: `used` and `allowance` are cents, shown as dollars. */
  money: boolean;
  billingUrl: string;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export function UsageNoticeEmail({
  orgName,
  meterLabel,
  threshold,
  used,
  allowance,
  money,
  billingUrl,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: UsageNoticeEmailProps): React.ReactElement {
  const t = emailTranslator({ locale, timeZone }, 'emails.usageNotice');
  const values = { org: orgName, meter: meterLabel, threshold };
  const amounts = money ? { used: used / 100, allowance: allowance / 100 } : { used, allowance };

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', values)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{t('heading', values)}</Text>
            <Text style={label}>{orgName}</Text>
            <Hr style={divider} />
            <Text style={text}>
              {money
                ? t('usedMoney', { ...values, ...amounts })
                : t('usedCount', { ...values, ...amounts })}
            </Text>
            <Text style={text}>{t('nothingStopped')}</Text>
            <Section style={{ textAlign: 'center', margin: '24px 0 8px' }}>
              <Button href={billingUrl} style={button}>
                {t('button')}
              </Button>
            </Section>
            <Text style={fineprint}>{t('fineprint', values)}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default UsageNoticeEmail;

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '40px 20px',
  maxWidth: '560px',
};

const section: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  padding: '32px',
  border: '1px solid #e5e7eb',
};

const heading: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: '600',
  color: '#111827',
  margin: '0 0 8px',
};

const label: React.CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  margin: '0 0 16px',
};

const divider: React.CSSProperties = {
  borderColor: '#e5e7eb',
  margin: '16px 0',
};

const text: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '22px',
  color: '#374151',
  margin: '0 0 12px',
};

const fineprint: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#6b7280',
  margin: '12px 0 0',
};

const button: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '10px 24px',
  fontSize: '14px',
  fontWeight: '600',
  textDecoration: 'none',
  display: 'inline-block',
};
