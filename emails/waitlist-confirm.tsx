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
  Link,
} from '@react-email/components';
import { BRAND } from '@/lib/brand';

/**
 * The waitlist confirmation email (§125 t-977). Registry kind
 * `waitlistConfirm`; a fork replaces it through `lib/app/emails.ts`.
 *
 * Sent to an address nobody has proved yet, so it says what to do if the
 * reader did not join, and it carries the leave link. `firstName` is already
 * filtered: it is a first name or null, never the raw text from the form.
 */
interface WaitlistConfirmEmailProps {
  firstName: string | null;
  confirmUrl: string;
  leaveUrl: string;
  expiresAt: Date;
}

export default function WaitlistConfirmEmail({
  firstName,
  confirmUrl,
  leaveUrl,
  expiresAt,
}: WaitlistConfirmEmailProps): React.ReactElement {
  const expiry = new Date(expiresAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>Confirm your place on the {BRAND.name} waitlist</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Confirm your email address</Text>
            <Text style={text}>{firstName ? `Hi ${firstName},` : 'Hello,'}</Text>
            <Text style={text}>
              Someone added this address to the {BRAND.name} waitlist. If it was you, confirm it
              below and we&apos;ll keep your place.
            </Text>
            <Button href={confirmUrl} style={button}>
              Confirm my address
            </Button>
            <Text style={small}>
              This link works once and expires on {expiry}. If you don&apos;t confirm, we delete the
              entry.
            </Text>
            <Text style={small}>
              If you didn&apos;t join, ignore this email, or{' '}
              <Link href={leaveUrl} style={link}>
                remove this address from the list
              </Link>{' '}
              now.
            </Text>
            <Text style={footer}>
              If the button doesn&apos;t work, paste this link into your browser:
            </Text>
            <Text style={rawLink}>{confirmUrl}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

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
};
const heading: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '24px',
};
const text: React.CSSProperties = { fontSize: '16px', lineHeight: '24px', color: '#333333' };
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
  margin: '24px 0',
};
const small: React.CSSProperties = { fontSize: '14px', lineHeight: '20px', color: '#666666' };
const link: React.CSSProperties = { color: '#0066cc' };
const footer: React.CSSProperties = { fontSize: '12px', color: '#999999', marginTop: '24px' };
const rawLink: React.CSSProperties = {
  fontSize: '12px',
  color: '#0066cc',
  wordBreak: 'break-all' as const,
};
