---
name: email-designer
version: 1.0.0
description: |
  Expert email template designer for Sunrise. Creates production-ready React Email
  templates with cross-client compatibility, mobile responsiveness, and clear CTAs.
  Ensures templates work across Gmail, Outlook, Apple Mail, and other clients.
  Use when creating new email templates or updating existing ones.

triggers:
  - 'create email template'
  - 'build email'
  - 'design email'
  - 'new email template'

contexts:
  - 'emails/**/*.tsx' # Will be created during Phase 3.1
  - '.context/email/overview.md' # Will be created during Phase 3.1

mcp_integrations:
  context7:
    libraries:
      - react-email: '/react.email/llmstxt' # Primary source
      - react-email-components: '/resend/react-email' # Component reference

parameters:
  max_width: 600 # Email width in pixels (standard)
  mobile_breakpoint: 480
  compatibility_targets: ['gmail', 'outlook', 'apple-mail', 'yahoo']
---

# Email Designer Skill - Overview

## Mission

You are an email template designer for the Sunrise project. Your role is to create production-ready email templates using **React Email** that work reliably across all major email clients while maintaining brand consistency and user experience.

**CRITICAL:** Always use Context7 MCP to get latest React Email patterns before creating templates.

## Technology Stack

- **Framework:** React Email (`@react-email/components`)
- **Rendering:** `@react-email/render` (server-side HTML generation)
- **Email Service:** Resend (delivery)
- **Styling:** Inline styles + optional Tailwind (with `pixelBasedPreset` for email compatibility)
- **Testing:** Vitest (template rendering tests)

**Note:** Supporting documentation files (patterns.md, compatibility.md) will be created in `.claude/skills/email-designer/` after implementing first templates in Phase 3.1.

## Core Design Principles

1. **Mobile-First:** Design for mobile, enhance for desktop
2. **Clear CTAs:** Single primary action per email, obvious button
3. **Accessibility:** Proper alt text, semantic HTML, readable fonts
4. **Cross-Client:** Test in Gmail, Outlook, Apple Mail, Yahoo
5. **Brand Consistency:** Use consistent colors, fonts, spacing
6. **Graceful Degradation:** Work without images, CSS support

## 4-Step Workflow

### Step 1: Understand Requirements

**Gather information:**

- Email purpose (welcome, verification, password reset, invitation, etc.)
- Required data (user name, links, expiry dates, etc.)
- Primary CTA (button text and action)
- Tone (formal, friendly, urgent, informative)

**Categorize template type:**

- **Transactional:** Verification, password reset, receipts
- **Notification:** Welcome, invitation, status updates
- **Marketing:** Announcements, newsletters (not in Phase 3.1)

### Step 2: Query React Email Documentation

**ALWAYS use Context7 for latest React Email patterns:**

```typescript
// Query for specific patterns
mcp__context7__query_docs({
  libraryId: '/react.email/llmstxt',
  query: 'button component link responsive layout container section',
});

// For Tailwind styling
mcp__context7__query_docs({
  libraryId: '/react.email/llmstxt',
  query: 'tailwind pixelBasedPreset email client compatibility',
});
```

**Key components from `@react-email/components`:**

- **Structure:** `Html`, `Head`, `Body`, `Preview`
- **Layout:** `Container`, `Section`, `Row`, `Column`
- **Typography:** `Text`, `Heading`, `Hr`
- **CTAs:** `Button`, `Link`
- **Media:** `Img`
- **Styling:** `Tailwind` (with `pixelBasedPreset` for email compatibility)

### Step 3: Build Email Template

**File naming:** `emails/[purpose].tsx`

- Examples: `welcome.tsx`, `verify-email.tsx`, `reset-password.tsx`, `invitation.tsx`

**Template structure (React Email latest patterns):**

```tsx
import * as React from 'react';
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Heading,
  Button,
  Hr,
  Link,
  Img,
  Preview,
} from '@react-email/components';

interface EmailNameProps {
  userName: string;
  actionUrl: string;
  expiresAt?: Date;
}

export default function EmailName({ userName, actionUrl, expiresAt }: EmailNameProps) {
  const previewText = 'Brief preview text shown in inbox';

  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Img
              src={`${process.env.NEXT_PUBLIC_APP_URL}/logo.png`}
              width="120"
              height="40"
              alt="Sunrise Logo"
            />
          </Section>

          {/* Content */}
          <Section style={content}>
            <Heading style={h1}>Email Heading</Heading>
            <Text style={text}>Hi {userName},</Text>
            <Text style={text}>Email body content explaining the purpose and action.</Text>

            {/* Primary CTA */}
            <Section style={buttonContainer}>
              <Button href={actionUrl} style={button}>
                Action Button Text
              </Button>
            </Section>

            {/* Alternative text link */}
            <Text style={text}>
              Or copy and paste this link:{' '}
              <Link href={actionUrl} style={link}>
                {actionUrl}
              </Link>
            </Text>

            {/* Expiry notice if applicable */}
            {expiresAt && (
              <Text style={notice}>
                This link expires on {expiresAt.toLocaleDateString()} at{' '}
                {expiresAt.toLocaleTimeString()}.
              </Text>
            )}
          </Section>

          {/* Footer */}
          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>
              © {new Date().getFullYear()} Sunrise. All rights reserved.
            </Text>
            <Text style={footerText}>
              <Link href={`${process.env.NEXT_PUBLIC_APP_URL}/privacy`} style={link}>
                Privacy Policy
              </Link>
              {' | '}
              <Link href={`${process.env.NEXT_PUBLIC_APP_URL}/terms`} style={link}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Inline styles for email client compatibility
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '600px',
};

const header = {
  padding: '24px',
  textAlign: 'center' as const,
};

const content = {
  padding: '0 48px',
};

const h1 = {
  color: '#1f2937',
  fontSize: '24px',
  fontWeight: '600',
  lineHeight: '32px',
  margin: '16px 0',
};

const text = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '16px 0',
};

const buttonContainer = {
  padding: '27px 0',
  textAlign: 'center' as const,
};

const button = {
  backgroundColor: '#2563eb',
  borderRadius: '8px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 20px',
};

const link = {
  color: '#2563eb',
  textDecoration: 'underline',
};

const notice = {
  color: '#6b7280',
  fontSize: '14px',
  lineHeight: '20px',
  margin: '16px 0',
  textAlign: 'center' as const,
};

const hr = {
  borderColor: '#e5e7eb',
  margin: '20px 0',
};

const footer = {
  padding: '0 48px',
};

const footerText = {
  color: '#6b7280',
  fontSize: '12px',
  lineHeight: '16px',
  margin: '8px 0',
  textAlign: 'center' as const,
};
```

**Key Pattern Updates:**

- ✅ Export `default function` (not named export)
- ✅ `Html lang="en"` attribute for accessibility
- ✅ `import * as React from 'react'` for React Email compatibility
- ✅ Use `process.env.NEXT_PUBLIC_APP_URL` for dynamic URLs
- ✅ Inline styles with proper TypeScript types (`as const`)
- ✅ Button `href` as first prop (React Email pattern)

### Step 4: Create Tests

**File:** `__tests__/unit/emails/[email-name].test.tsx`

**Pattern (React Email latest):**

```tsx
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import WelcomeEmail from '@/emails/welcome';

describe('WelcomeEmail', () => {
  it('should render with user name', async () => {
    const html = await render(<WelcomeEmail userName="John Doe" userEmail="john@example.com" />);

    expect(html).toContain('John Doe');
    expect(html).toContain('Welcome to Sunrise');
  });

  it('should include preview text', async () => {
    const html = await render(<WelcomeEmail userName="John Doe" userEmail="john@example.com" />);

    expect(html).toContain('Welcome to Sunrise');
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<WelcomeEmail userName="John Doe" userEmail="john@example.com" />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('<html');
    expect(html).toContain('lang="en"');
    expect(html).toContain('</html>');
  });

  it('should include CTA button with href', async () => {
    const html = await render(<WelcomeEmail userName="John Doe" userEmail="john@example.com" />);

    expect(html).toContain('href=');
    expect(html).toContain('Get Started'); // or similar CTA text
  });

  it('should render without errors', () => {
    expect(() => {
      render(<WelcomeEmail userName="John Doe" userEmail="john@example.com" />);
    }).not.toThrow();
  });
});
```

**Key Test Patterns:**

- ✅ Import default export (not named export)
- ✅ Use `render()` from `@react-email/render`
- ✅ Test returns string HTML (use `.toContain()`)
- ✅ Verify HTML structure, preview text, dynamic content
- ✅ Test that rendering doesn't throw errors

## Email Template Types

### 1. Welcome Email

**Purpose:** Greet new users after signup
**Props:** `userName`, `userEmail`
**CTA:** "Get Started" → Dashboard
**Tone:** Friendly, enthusiastic

### 2. Email Verification

**Purpose:** Verify email address
**Props:** `userName`, `verificationUrl`, `expiresAt`
**CTA:** "Verify Email" → Verification handler
**Tone:** Clear, helpful
**Critical:** Include expiry notice

### 3. Password Reset

**Purpose:** Allow users to reset forgotten password
**Props:** `userName`, `resetUrl`, `expiresAt`
**CTA:** "Reset Password" → Reset handler
**Tone:** Helpful, secure
**Critical:** Security notice, expiry warning, "didn't request this?" text

### 4. Invitation

**Purpose:** Invite new user to join
**Props:** `inviterName`, `inviteeName`, `inviteeEmail`, `invitationUrl`, `expiresAt`
**CTA:** "Accept Invitation" → Invitation handler
**Tone:** Personal, welcoming
**Critical:** Who invited them, what happens next, expiry notice

## Design Best Practices

### Colors

```typescript
// Primary brand color
const primary = '#2563eb'; // Blue-600

// Text colors
const textPrimary = '#1f2937'; // Gray-800
const textSecondary = '#374151'; // Gray-700
const textMuted = '#6b7280'; // Gray-500

// Background colors
const bgPrimary = '#ffffff'; // White
const bgSecondary = '#f6f9fc'; // Light blue-gray

// Borders
const borderColor = '#e5e7eb'; // Gray-200
```

### Typography

```typescript
// Font stack (email-safe)
const fontFamily =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif';

// Sizes
const h1 = { fontSize: '24px', lineHeight: '32px', fontWeight: '600' };
const h2 = { fontSize: '20px', lineHeight: '28px', fontWeight: '600' };
const body = { fontSize: '16px', lineHeight: '24px' };
const small = { fontSize: '14px', lineHeight: '20px' };
const tiny = { fontSize: '12px', lineHeight: '16px' };
```

### Spacing

```typescript
// Container padding
const containerPadding = '0 48px';

// Section spacing
const sectionMargin = '32px 0';

// Text spacing
const textMargin = '16px 0';

// Button padding
const buttonPadding = '12px 20px';
```

### Buttons

```typescript
// Primary button (CTAs)
const buttonPrimary = {
  backgroundColor: '#2563eb',
  color: '#ffffff',
  padding: '12px 20px',
  borderRadius: '8px',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  display: 'block',
  textAlign: 'center' as const,
};

// Secondary button (optional actions)
const buttonSecondary = {
  backgroundColor: '#ffffff',
  color: '#2563eb',
  border: '1px solid #2563eb',
  padding: '12px 20px',
  borderRadius: '8px',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  display: 'block',
  textAlign: 'center' as const,
};
```

## Cross-Client Compatibility

### Email Client Support Matrix

- **Gmail** (Web, iOS, Android) - Good CSS support
- **Outlook** (Desktop, Web) - Limited CSS, use tables for layout
- **Apple Mail** (iOS, macOS) - Excellent CSS support
- **Yahoo Mail** - Good CSS support
- **Thunderbird** - Good CSS support

### Compatibility Rules

**DO:**

- Use inline styles (not `<style>` tags or external CSS)
- Use tables for complex layouts (fallback for Outlook)
- Use web-safe fonts
- Provide alt text for all images
- Include plain text fallbacks for links
- Test with images disabled

**DON'T:**

- Don't rely on `<style>` tags (Outlook strips them)
- Don't use `float` or `position` (inconsistent support)
- Don't use background images (Outlook doesn't support)
- Don't use custom fonts (may not load)
- Don't assume JavaScript works (it doesn't in email)

### Mobile Responsiveness

```typescript
// Mobile-first approach
const container = {
  maxWidth: '600px',
  width: '100%',
};

// Responsive text
const heading = {
  fontSize: '24px', // Desktop
  '@media only screen and (max-width: 480px)': {
    fontSize: '20px !important', // Mobile
  },
};

// Responsive padding
const content = {
  padding: '0 48px', // Desktop
  '@media only screen and (max-width: 480px)': {
    padding: '0 24px !important', // Mobile
  },
};
```

## Testing Checklist

**Rendering Tests:**

- [ ] Template renders without errors
- [ ] All props are used correctly
- [ ] Preview text is present
- [ ] Required elements exist (CTA, logo, footer)

**Content Tests:**

- [ ] User name appears correctly
- [ ] Links are properly formatted
- [ ] Expiry dates are formatted (if applicable)
- [ ] Footer links are present

**Visual Tests (Manual):**

- [ ] Test in Gmail (web + mobile)
- [ ] Test in Outlook (desktop + web)
- [ ] Test in Apple Mail (iOS + macOS)
- [ ] Test with images disabled
- [ ] Test on mobile devices (320px, 375px, 414px widths)

**Accessibility:**

- [ ] All images have alt text
- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] Links are descriptive
- [ ] Semantic HTML structure

## Development Workflow

**Preview in Browser:**

```bash
npm run email:dev
# Opens React Email dev server at http://localhost:3000
```

**Export Static HTML:**

```bash
npm run email:export
# Generates HTML files in .react-email/ directory
```

**Test Rendering:**

```bash
npm run test -- emails/
# Runs all email template tests
```

## Common Patterns

### Conditional Content

```typescript
{expiresAt && (
  <Text style={notice}>
    This link expires on {expiresAt.toLocaleDateString()}.
  </Text>
)}

{userName ? `Hi ${userName}` : 'Hi there'}
```

### Multiple CTAs

```typescript
{/* Primary CTA */}
<Button style={buttonPrimary} href={primaryUrl}>
  Primary Action
</Button>

{/* Secondary CTA */}
<Button style={buttonSecondary} href={secondaryUrl}>
  Secondary Action
</Button>
```

### Lists

```typescript
<ul style={{ margin: '16px 0', paddingLeft: '20px' }}>
  <li style={{ margin: '8px 0' }}>List item 1</li>
  <li style={{ margin: '8px 0' }}>List item 2</li>
  <li style={{ margin: '8px 0' }}>List item 3</li>
</ul>
```

### Social Links (Footer)

```typescript
<Section style={{ textAlign: 'center', margin: '24px 0' }}>
  <Link href="https://twitter.com/yourapp" style={socialLink}>
    <Img src="https://yourdomain.com/icons/twitter.png" width="24" height="24" alt="Twitter" />
  </Link>
  <Link href="https://facebook.com/yourapp" style={socialLink}>
    <Img src="https://yourdomain.com/icons/facebook.png" width="24" height="24" alt="Facebook" />
  </Link>
</Section>
```

## Related Documentation

**Will be created during/after Phase 3.1 implementation:**

- `.context/email/overview.md` - Email system architecture (Phase 3.1)
- `.claude/skills/email-designer/patterns.md` - Common email patterns (after first templates)
- `.claude/skills/email-designer/compatibility.md` - Email client compatibility guide (after testing)
- `emails/` - Email template examples (Phase 3.1)

**Use for current patterns:**

- React Email documentation via Context7 (`/react.email/llmstxt`)
- Resend documentation via Context7 (`/resend/react-email`)

**Note:** Supporting documentation files will be created after implementing the first working email templates in Phase 3.1, following the same pattern as the testing skill (created supporting docs after working code existed).

## Usage Examples

**Create welcome email:**

```
User: "Create a welcome email template for new users"
Assistant: [Creates emails/welcome.tsx with friendly greeting, dashboard CTA, tests]
```

**Create verification email:**

```
User: "Build an email verification template with expiry warning"
Assistant: [Creates emails/verify-email.tsx with verification button, expiry notice, security text, tests]
```

**Update existing template:**

```
User: "Add social links to the invitation email footer"
Assistant: [Updates emails/invitation.tsx footer with Twitter/Facebook links, updates tests]
```
