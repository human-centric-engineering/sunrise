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
import { DEFAULT_EMAIL_LOCALE, emailDateTime, emailTranslator } from '@/lib/email/translate';

interface ChangeEmailApprovalProps {
  userName: string;
  /** The address this email is sent to — the one currently on the account. */
  currentEmail: string;
  /** The address the account would move to if this is approved. */
  newEmail: string;
  approvalUrl: string;
  expiresAt: Date;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

/**
 * Sent to the CURRENT (old) address when someone asks to move the account to a
 * new one. Nothing changes until this link is clicked.
 *
 * This is the control that makes a stolen session insufficient for account
 * takeover: whoever holds the session can request the change, but only someone
 * who can read the original inbox can complete it. That is why the copy leads
 * with the "didn't do this?" path rather than burying it — for the recipient
 * who did not initiate this, the email is a compromise alert, not a receipt.
 */
export default function ChangeEmailApproval({
  userName,
  currentEmail,
  newEmail,
  approvalUrl,
  expiresAt,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: ChangeEmailApprovalProps): React.ReactElement {
  const where = { locale, timeZone };
  const t = emailTranslator(where, 'emails.changeEmailApproval');
  const common = emailTranslator(where, 'emails.common');
  const brand = BRAND.name;
  const expirationTime = emailDateTime(where, expiresAt);

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', { brand })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{t('heading')}</Text>
            <Text style={text}>{common('greeting', { name: userName })}</Text>
            <Text style={text}>
              {t.rich('request', {
                brand,
                current: currentEmail,
                next: newEmail,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Text>
            <Text style={text}>{t('notYet', { next: newEmail })}</Text>
            <Button href={approvalUrl} style={button}>
              {t('button')}
            </Button>
            <Text style={expiryNotice}>{t('expiry', { time: expirationTime })}</Text>
            <Section style={warningSection}>
              <Text style={warningHeading}>{t('warningHeading')}</Text>
              <Text style={warningText}>{t('warningDontClick')}</Text>
              <Text style={warningText}>{t('warningSignIn')}</Text>
            </Section>
            <Text style={footerSmall}>{common('buttonFallback')}</Text>
            <Text style={link}>{approvalUrl}</Text>
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

const expiryNotice: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#666666',
  backgroundColor: '#fef3cd',
  padding: '12px 16px',
  borderRadius: '6px',
  marginTop: '16px',
  marginBottom: '24px',
  border: '1px solid #ffc107',
};

// Red rather than the neutral grey used by the other templates' "security note"
// blocks: for a recipient who did not initiate this, this section is the alert.
const warningSection: React.CSSProperties = {
  backgroundColor: '#fdf2f2',
  borderRadius: '6px',
  padding: '20px',
  marginTop: '24px',
  marginBottom: '24px',
  border: '1px solid #f5c2c7',
};

const warningHeading: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: '600',
  color: '#842029',
  marginTop: '0',
  marginBottom: '12px',
};

const warningText: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#842029',
  marginBottom: '12px',
};

const footerSmall: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#999999',
  marginTop: '16px',
  marginBottom: '8px',
};

const link: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#0066cc',
  wordBreak: 'break-all' as const,
  marginTop: '4px',
};
