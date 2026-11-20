import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Button,
  Link,
} from '@react-email/components';
import { BRAND } from '@/lib/brand';
import { DEFAULT_EMAIL_LOCALE, emailDate, emailTranslator } from '@/lib/email/translate';

/**
 * The waitlist confirmation email (§125 t-977). Registry kind
 * `waitlistConfirm`; a fork replaces it through `lib/app/emails.ts`.
 *
 * Sent to an address nobody has proved yet, so it says what to do if the
 * reader did not join, and it carries the leave link. `firstName` is already
 * filtered: it is a first name or null, never the raw text from the form.
 */
interface WaitlistConfirmEmailProps {
  firstName: string | null;
  confirmUrl: string;
  leaveUrl: string;
  expiresAt: Date;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export default function WaitlistConfirmEmail({
  firstName,
  confirmUrl,
  leaveUrl,
  expiresAt,
  locale = DEFAULT_EMAIL_LOCALE.locale,
}: WaitlistConfirmEmailProps): React.ReactElement {
  // In UTC, and said so: nobody on the list has a zone of their own.
  const where = { locale, timeZone: 'UTC' };
  const t = emailTranslator(where, 'emails.waitlistConfirm');
  const common = emailTranslator(where, 'emails.common');
  const brand = BRAND.name;
  const expiry = emailDate(where, expiresAt);

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
            <Button href={confirmUrl} style={button}>
              {t('button')}
            </Button>
            <Text style={small}>{t('expiry', { date: expiry })}</Text>
            <Text style={small}>
              {t.rich('leave', {
                link: (chunks) => (
                  <Link href={leaveUrl} style={link}>
                    {chunks}
                  </Link>
                ),
              })}
            </Text>
            <Text style={footer}>{t('buttonFallback')}</Text>
            <Text style={rawLink}>{confirmUrl}</Text>
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
const button: React.CSSProperties = {
  backgroundColor: '#000000',
  borderRadius: '6px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 24px',
  margin: '24px 0',
};
const small: React.CSSProperties = { fontSize: '14px', lineHeight: '20px', color: '#666666' };
const link: React.CSSProperties = { color: '#0066cc' };
const footer: React.CSSProperties = { fontSize: '12px', color: '#999999', marginTop: '24px' };
const rawLink: React.CSSProperties = {
  fontSize: '12px',
  color: '#0066cc',
  wordBreak: 'break-all' as const,
};
