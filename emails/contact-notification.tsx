import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Hr } from '@react-email/components';

interface ContactNotificationEmailProps {
  name: string;
  email: string;
  subject: string;
  message: string;
  submittedAt: Date;
}

export default function ContactNotificationEmail({
  name,
  email,
  subject,
  message,
  submittedAt,
}: ContactNotificationEmailProps): React.ReactElement {
  const formattedDate = submittedAt.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>New contact form submission from {name}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>New Contact Form Submission</Text>
            <Text style={text}>
              You have received a new message from your website contact form.
            </Text>

            <Hr style={divider} />

            <Text style={label}>From</Text>
            <Text style={value}>
              {name} ({email})
            </Text>

            <Text style={label}>Subject</Text>
            <Text style={value}>{subject}</Text>

            <Text style={label}>Message</Text>
            <Text style={messageStyle}>{message}</Text>

            <Hr style={divider} />

            <Text style={footerSmall}>Submitted on {formattedDate}</Text>
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
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginBottom: '16px',
  marginTop: '0',
};

const text: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
  marginBottom: '16px',
};

const divider: React.CSSProperties = {
  borderColor: '#e6e6e6',
  margin: '24px 0',
};

const label: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: '600',
  color: '#666666',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '4px',
  marginTop: '16px',
};

const value: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '0',
};

const messageStyle: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '0',
  whiteSpace: 'pre-wrap',
  backgroundColor: '#f9fafb',
  padding: '16px',
  borderRadius: '6px',
};

const footerSmall: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#999999',
  marginTop: '16px',
};
