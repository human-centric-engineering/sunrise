import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Hr } from '@react-email/components';

interface WorkflowNotificationProps {
  body: string;
  workflowName: string;
}

export function WorkflowNotification({
  body,
  workflowName,
}: WorkflowNotificationProps): React.ReactElement {
  return (
    <Html lang="en">
      <Head />
      <Preview>Notification from workflow: {workflowName}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Workflow Notification</Text>
            <Text style={label}>From: {workflowName}</Text>
            <Hr style={divider} />
            <Text style={text}>{body}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default WorkflowNotification;

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
  lineHeight: '24px',
  color: '#374151',
  margin: '0',
  whiteSpace: 'pre-wrap',
};
