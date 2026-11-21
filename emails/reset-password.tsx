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
  Hr,
  Heading,
} from '@react-email/components';
import { DEFAULT_EMAIL_LOCALE, emailDateTime, emailTranslator } from '@/lib/email/translate';

interface ResetPasswordEmailProps {
  userName: string;
  resetUrl: string;
  expiresAt: Date;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export default function ResetPasswordEmail({
  userName,
  resetUrl,
  expiresAt,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: ResetPasswordEmailProps): React.ReactElement {
  const where = { locale, timeZone };
  const t = emailTranslator(where, 'emails.resetPassword');
  const common = emailTranslator(where, 'emails.common');
  const expirationTime = emailDateTime(where, expiresAt);

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview')}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{t('heading')}</Heading>

          <Text style={text}>{common('greeting', { name: userName })}</Text>

          <Text style={text}>{t('body')}</Text>

          <Section style={buttonContainer}>
            <Button href={resetUrl} style={button}>
              {t('button')}
            </Button>
          </Section>

          <Text style={text}>{t('expiry', { time: expirationTime })}</Text>

          <Hr style={hr} />

          <Text style={footer}>
            {t.rich('security', { strong: (chunks) => <strong>{chunks}</strong> })}
          </Text>

          <Text style={footer}>
            {common('buttonFallback')}
            <br />
            <a href={resetUrl} style={link}>
              {resetUrl}
            </a>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '580px',
};

const h1: React.CSSProperties = {
  color: '#333',
  fontSize: '24px',
  fontWeight: '600',
  lineHeight: '40px',
  margin: '0 0 20px',
  padding: '0 48px',
};

const text: React.CSSProperties = {
  color: '#333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
  padding: '0 48px',
};

const buttonContainer: React.CSSProperties = {
  padding: '27px 48px',
};

const button: React.CSSProperties = {
  backgroundColor: '#5469d4',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 20px',
};

const hr: React.CSSProperties = {
  borderColor: '#e6ebf1',
  margin: '20px 0',
};

const footer: React.CSSProperties = {
  color: '#8898aa',
  fontSize: '14px',
  lineHeight: '24px',
  margin: '16px 0',
  padding: '0 48px',
};

const link: React.CSSProperties = {
  color: '#5469d4',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};
