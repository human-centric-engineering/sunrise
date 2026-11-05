import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Link } from '@react-email/components';
import { BRAND } from '@/lib/brand';

/**
 * The note a confirmed address gets when it is submitted again (§125 t-977).
 * Registry kind `waitlistAlreadyOnList`; a fork replaces it through
 * `lib/app/emails.ts`.
 *
 * It carries no confirm link — the address is already confirmed — and it
 * does not repeat what was submitted: the second submitter may not be the
 * owner. `firstName` is already filtered, as for the confirmation.
 */
interface WaitlistAlreadyOnListEmailProps {
  firstName: string | null;
  leaveUrl: string;
}

export default function WaitlistAlreadyOnListEmail({
  firstName,
  leaveUrl,
}: WaitlistAlreadyOnListEmailProps): React.ReactElement {
  return (
    <Html lang="en">
      <Head />
      <Preview>You&apos;re already on the {BRAND.name} waitlist</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>You&apos;re already on the list</Text>
            <Text style={text}>{firstName ? `Hi ${firstName},` : 'Hello,'}</Text>
            <Text style={text}>
              This address was just submitted to the {BRAND.name} waitlist again. It&apos;s already
              confirmed, so there&apos;s nothing you need to do. We&apos;ll be in touch when
              there&apos;s a place for you.
            </Text>
            <Text style={small}>
              If you want to come off the list,{' '}
              <Link href={leaveUrl} style={link}>
                remove this address
              </Link>
              .
            </Text>
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
const small: React.CSSProperties = { fontSize: '14px', lineHeight: '20px', color: '#666666' };
const link: React.CSSProperties = { color: '#0066cc' };
