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

interface WelcomeEmailProps {
  userName: string;
  userEmail: string;
}

export default function WelcomeEmail({ userName, userEmail }: WelcomeEmailProps) {
  const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard`;

  return (
    <Html lang="en">
      <Head />
      <Preview>Welcome to Sunrise - Let&apos;s get started</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Welcome to Sunrise!</Text>
            <Text style={text}>Hi {userName},</Text>
            <Text style={text}>
              We&apos;re excited to have you on board! Sunrise is your production-ready Next.js
              starter template designed for rapid application development.
            </Text>
            <Text style={text}>
              You&apos;re all set up and ready to go. Click the button below to access your
              dashboard and start exploring.
            </Text>
            <Button href={dashboardUrl} style={button}>
              Get Started
            </Button>
            <Text style={footer}>
              If you have any questions, feel free to reach out. We&apos;re here to help!
            </Text>
            <Text style={footerSmall}>
              You&apos;re receiving this email because you signed up at {userEmail}
            </Text>
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
