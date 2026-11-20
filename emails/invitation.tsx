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
import { BRAND } from '@/lib/brand';
import { DEFAULT_EMAIL_LOCALE, emailDateTime, emailTranslator } from '@/lib/email/translate';

interface InvitationEmailProps {
  inviterName: string;
  inviteeName: string;
  inviteeEmail: string;
  invitationUrl: string;
  expiresAt: Date;
  /** The org the invitation joins. Absent ⇒ the app. */
  orgName?: string;
  /** The address already has an account: sign in and accept, no password to set. */
  hasAccount?: boolean;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export default function InvitationEmail({
  inviterName,
  inviteeName,
  inviteeEmail,
  invitationUrl,
  expiresAt,
  orgName,
  hasAccount = false,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: InvitationEmailProps): React.ReactElement {
  const where = { locale, timeZone };
  const t = emailTranslator(where, 'emails.invitation');
  const common = emailTranslator(where, 'emails.common');
  const brand = BRAND.name;
  const joining = orgName ?? brand;
  const expirationTime = emailDateTime(where, expiresAt);

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', { org: joining })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{t('heading')}</Heading>

          <Text style={text}>{common('greeting', { name: inviteeName })}</Text>

          <Text style={text}>
            {orgName
              ? t.rich('invitedToOrg', {
                  inviter: inviterName,
                  org: orgName,
                  brand,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              : t.rich('invitedToApp', {
                  inviter: inviterName,
                  brand,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
          </Text>

          <Section style={infoBox}>
            <Text style={infoText}>
              <strong>{t('accountLabel')}</strong>
              <br />
              {inviteeEmail}
            </Text>
          </Section>

          <Text style={text}>
            {hasAccount ? t('hasAccount', { brand, email: inviteeEmail }) : t('newAccount')}
          </Text>

          <Section style={buttonContainer}>
            <Button href={invitationUrl} style={button}>
              {t('button')}
            </Button>
          </Section>

          <Text style={text}>{t('expiry', { time: expirationTime })}</Text>

          <ul style={list}>
            {hasAccount ? (
              <li style={listItem}>{t('switchTo', { org: joining })}</li>
            ) : (
              <li style={listItem}>{t('setPassword')}</li>
            )}
            <li style={listItem}>{t('dashboard')}</li>
            <li style={listItem}>{t('collaborate')}</li>
          </ul>

          <Hr style={hr} />

          <Text style={footer}>{t('notExpecting')}</Text>

          <Text style={footer}>
            {common('buttonFallback')}
            <br />
            <a href={invitationUrl} style={link}>
              {invitationUrl}
            </a>
          </Text>

          <Text style={footer}>{t('questions', { inviter: inviterName })}</Text>
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
  fontSize: '28px',
  fontWeight: '700',
  lineHeight: '40px',
  margin: '0 0 24px',
  padding: '0 48px',
  textAlign: 'center' as const,
};

const text: React.CSSProperties = {
  color: '#333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
  padding: '0 48px',
};

const infoBox: React.CSSProperties = {
  backgroundColor: '#f0f4ff',
  borderRadius: '5px',
  margin: '24px 48px',
  padding: '16px',
};

const infoText: React.CSSProperties = {
  color: '#333',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0',
};

const buttonContainer: React.CSSProperties = {
  padding: '27px 48px',
  textAlign: 'center' as const,
};

const button: React.CSSProperties = {
  backgroundColor: '#5469d4',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 32px',
};

const list: React.CSSProperties = {
  color: '#333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
  padding: '0 48px',
};

const listItem: React.CSSProperties = {
  marginBottom: '8px',
};

const hr: React.CSSProperties = {
  borderColor: '#e6ebf1',
  margin: '32px 0',
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
