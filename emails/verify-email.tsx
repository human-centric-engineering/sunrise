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

interface VerifyEmailProps {
  userName: string;
  verificationUrl: string;
  expiresAt: Date;
}

export default function VerifyEmail({ userName, verificationUrl, expiresAt }: VerifyEmailProps) {
  // Format expiration time
  const expirationTime = new Date(expiresAt).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>Verify your email address</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Verify Your Email Address</Text>
            <Text style={text}>Hi {userName},</Text>
            <Text style={text}>
              Thanks for signing up! To complete your registration and start using Sunrise, please
              verify your email address by clicking the button below.
            </Text>
            <Button href={verificationUrl} style={button}>
              Verify Email
            </Button>
            <Text style={expiryNotice}>This verification link will expire on {expirationTime}</Text>
            <Section style={securitySection}>
              <Text style={securityHeading}>Security Note</Text>
              <Text style={securityText}>
                For your security, this link can only be used once and will expire after the time
                shown above.
              </Text>
              <Text style={securityText}>
                If you didn&apos;t request this verification email, you can safely ignore it. Your
                account will not be created without clicking the verification link.
              </Text>
            </Section>
            <Text style={footerSmall}>
              If the button doesn&apos;t work, copy and paste this link into your browser:
            </Text>
            <Text style={link}>{verificationUrl}</Text>
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

const securitySection: React.CSSProperties = {
  backgroundColor: '#f8f9fa',
  borderRadius: '6px',
  padding: '20px',
  marginTop: '24px',
  marginBottom: '24px',
};

const securityHeading: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: '600',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '12px',
};

const securityText: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#666666',
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
