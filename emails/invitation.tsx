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

interface InvitationEmailProps {
  inviterName: string;
  inviteeName: string;
  inviteeEmail: string;
  invitationUrl: string;
  expiresAt: Date;
}

export default function InvitationEmail({
  inviterName,
  inviteeName,
  inviteeEmail,
  invitationUrl,
  expiresAt,
}: InvitationEmailProps) {
  const previewText = "You've been invited to join Sunrise";
  const appName = 'Sunrise';

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
          <Heading style={h1}>You&apos;ve Been Invited!</Heading>

          <Text style={text}>Hi {inviteeName},</Text>

          <Text style={text}>
            <strong>{inviterName}</strong> has invited you to join <strong>{appName}</strong>.
            We&apos;re excited to have you on board!
          </Text>

          <Section style={infoBox}>
            <Text style={infoText}>
              <strong>Your Account:</strong>
              <br />
              {inviteeEmail}
            </Text>
          </Section>

          <Text style={text}>
            Click the button below to accept your invitation and set up your password:
          </Text>

          <Section style={buttonContainer}>
            <Button href={invitationUrl} style={button}>
              Accept Invitation
            </Button>
          </Section>

          <Text style={text}>
            This invitation will expire on {expirationTime}. After accepting, you&apos;ll be able
            to:
          </Text>

          <ul style={list}>
            <li style={listItem}>Set your own secure password</li>
            <li style={listItem}>Access your personalized dashboard</li>
            <li style={listItem}>Start collaborating with your team</li>
          </ul>

          <Hr style={hr} />

          <Text style={footer}>
            If you weren&apos;t expecting this invitation or don&apos;t want to join, you can safely
            ignore this email.
          </Text>

          <Text style={footer}>
            If the button doesn&apos;t work, copy and paste this link into your browser:
            <br />
            <a href={invitationUrl} style={link}>
              {invitationUrl}
            </a>
          </Text>

          <Text style={footer}>
            Questions? Contact {inviterName} or our support team for assistance.
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
