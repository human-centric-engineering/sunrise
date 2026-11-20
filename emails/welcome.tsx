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
} from '@react-email/components';
import { BRAND } from '@/lib/brand';
import { DEFAULT_EMAIL_LOCALE, emailTranslator } from '@/lib/email/translate';

interface WelcomeEmailProps {
  userName: string;
  userEmail: string;
  /** Base URL of the application (e.g., "https://example.com") */
  baseUrl: string;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export default function WelcomeEmail({
  userName,
  userEmail,
  baseUrl,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: WelcomeEmailProps): React.ReactElement {
  const dashboardUrl = `${baseUrl}/dashboard`;
  const t = emailTranslator({ locale, timeZone }, 'emails.welcome');
  const common = emailTranslator({ locale, timeZone }, 'emails.common');
  const brand = BRAND.name;

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', { brand })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{t('heading', { brand })}</Text>
            <Text style={text}>{common('greeting', { name: userName })}</Text>
            <Text style={text}>{t('intro', { brand })}</Text>
            <Text style={text}>{t('ready')}</Text>
            <Button href={dashboardUrl} style={button}>
              {t('button')}
            </Button>
            <Text style={footer}>{t('help')}</Text>
            <Text style={footerSmall}>{t('reason', { email: userEmail })}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
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
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
};

const heading: React.CSSProperties = {
  fontSize: '28px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginBottom: '24px',
  marginTop: '0',
};

const text: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
  marginBottom: '16px',
};

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
  marginTop: '24px',
  marginBottom: '24px',
};

const footer: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#666666',
  marginTop: '24px',
  marginBottom: '8px',
};

const footerSmall: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#999999',
  marginTop: '16px',
};
