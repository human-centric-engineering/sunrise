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

interface ResetPasswordEmailProps {
  userName: string;
  resetUrl: string;
  expiresAt: Date;
}

export default function ResetPasswordEmail({
  userName,
  resetUrl,
  expiresAt,
}: ResetPasswordEmailProps) {
  const previewText = 'Reset your password';

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
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Reset Your Password</Heading>

          <Text style={text}>Hi {userName},</Text>

          <Text style={text}>
            We received a request to reset the password for your account. Click the button below to
            create a new password:
          </Text>

          <Section style={buttonContainer}>
            <Button href={resetUrl} style={button}>
              Reset Password
            </Button>
          </Section>

          <Text style={text}>
            This link will expire on {expirationTime}. If you didn&apos;t request a password reset,
            you can safely ignore this email.
          </Text>

          <Hr style={hr} />

          <Text style={footer}>
            <strong>Security Notice:</strong> Never share this link with anyone. If you didn&apos;t
            request this reset, your account may be at risk. Please contact support immediately.
          </Text>

          <Text style={footer}>
            If the button doesn&apos;t work, copy and paste this link into your browser:
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
