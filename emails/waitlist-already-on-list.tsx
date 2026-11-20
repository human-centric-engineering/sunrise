import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Link } from '@react-email/components';
import { BRAND } from '@/lib/brand';
import { DEFAULT_EMAIL_LOCALE, emailTranslator } from '@/lib/email/translate';

/**
 * The note a confirmed address gets when it is submitted again (§125 t-977).
 * Registry kind `waitlistAlreadyOnList`; a fork replaces it through
 * `lib/app/emails.ts`.
 *
 * It carries no confirm link — the address is already confirmed — and it
 * does not repeat what was submitted: the second submitter may not be the
 * owner. `firstName` is already filtered, as for the confirmation.
 */
interface WaitlistAlreadyOnListEmailProps {
  firstName: string | null;
  leaveUrl: string;
  /** The recipient's language (`lib/email/locale.ts`). Absent ⇒ English. */
  locale?: string;
}

export default function WaitlistAlreadyOnListEmail({
  firstName,
  leaveUrl,
  locale = DEFAULT_EMAIL_LOCALE.locale,
}: WaitlistAlreadyOnListEmailProps): React.ReactElement {
  const where = { locale, timeZone: 'UTC' };
  const t = emailTranslator(where, 'emails.waitlistAlreadyOnList');
  const common = emailTranslator(where, 'emails.common');
  const brand = BRAND.name;
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', { brand })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{t('heading')}</Text>
            <Text style={text}>
              {firstName ? common('greeting', { name: firstName }) : common('hello')}
            </Text>
            <Text style={text}>{t('body', { brand })}</Text>
            <Text style={small}>
              {t.rich('leave', {
                link: (chunks) => (
                  <Link href={leaveUrl} style={link}>
                    {chunks}
                  </Link>
                ),
              })}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};
const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '20px 0 48px',
  maxWidth: '580px',
};
const section: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  padding: '40px',
};
const heading: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '24px',
};
const text: React.CSSProperties = { fontSize: '16px', lineHeight: '24px', color: '#333333' };
const small: React.CSSProperties = { fontSize: '14px', lineHeight: '20px', color: '#666666' };
const link: React.CSSProperties = { color: '#0066cc' };
