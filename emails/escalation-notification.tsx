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

interface EscalationNotificationProps {
  agentName: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  conversationId: string | null;
  appUrl?: string;
}

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function EscalationNotification({
  agentName,
  reason,
  priority,
  conversationId,
  appUrl,
}: EscalationNotificationProps): React.ReactElement {
  const conversationUrl =
    appUrl && conversationId
      ? `${appUrl}/admin/orchestration/conversations/${conversationId}`
      : null;

  return (
    <Html lang="en">
      <Head />
      <Preview>
        Escalation ({PRIORITY_LABELS[priority]}): {reason.slice(0, 80)}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Human Escalation Required</Text>
            <Text style={label}>
              Agent: <strong>{agentName}</strong> &middot; Priority:{' '}
              <strong>{PRIORITY_LABELS[priority]}</strong>
            </Text>
            <Hr style={divider} />
            <Text style={text}>{reason}</Text>
            {conversationUrl && (
              <>
                <Hr style={divider} />
                <Link href={conversationUrl} style={link}>
                  View conversation
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
