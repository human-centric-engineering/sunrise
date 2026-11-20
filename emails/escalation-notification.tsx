import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Hr,
  Link,
} from '@react-email/components';
import { DEFAULT_EMAIL_LOCALE, emailTranslator } from '@/lib/email/translate';

interface EscalationNotificationProps {
  agentName: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  conversationId: string | null;
  appUrl?: string;
  /** The recipient's language and time zone (`lib/email/locale.ts`). Absent ⇒ English, UTC. */
  locale?: string;
  timeZone?: string;
}

export function EscalationNotification({
  agentName,
  reason,
  priority,
  conversationId,
  appUrl,
  locale = DEFAULT_EMAIL_LOCALE.locale,
  timeZone = DEFAULT_EMAIL_LOCALE.timeZone,
}: EscalationNotificationProps): React.ReactElement {
  const t = emailTranslator({ locale, timeZone }, 'emails.escalationNotification');
  const priorityLabel = t('priority', { priority });
  const conversationUrl =
    appUrl && conversationId
      ? `${appUrl}/admin/orchestration/conversations/${conversationId}`
      : null;

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{t('preview', { priority: priorityLabel, reason: reason.slice(0, 80) })}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{t('heading')}</Text>
            <Text style={label}>
              {t.rich('meta', {
                agent: agentName,
                priority: priorityLabel,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Text>
            <Hr style={divider} />
            <Text style={text}>{reason}</Text>
            {conversationUrl && (
              <>
                <Hr style={divider} />
                <Link href={conversationUrl} style={link}>
                  {t('view')}
                </Link>
              </>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default EscalationNotification;

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
  color: '#dc2626',
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
  lineHeight: '24px',
  color: '#374151',
  margin: '0',
  whiteSpace: 'pre-wrap',
};

const link: React.CSSProperties = {
  fontSize: '14px',
  color: '#2563eb',
};
