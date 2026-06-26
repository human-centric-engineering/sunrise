/**
 * Email template resolver — per-kind override + platform fallback.
 *
 * Platform call sites render auth emails through {@link resolveEmailTemplate}
 * instead of importing a template directly, so a fork can swap any email's copy
 * by registering a component in `lib/app/emails.ts` while the platform defaults
 * serve the rest. The defaults in `emails/*` stay untouched as living reference
 * implementations a fork copies into `components/app/emails/*` and adapts.
 *
 * **Props contract:** {@link EmailPropsMap} is the stable, typed contract per
 * email kind — the same shape the platform passes and an override must accept.
 * Changing a kind's props is therefore a versioned public-surface change
 * (CHANGELOG). The `defaultTemplates` assignment below type-checks that each
 * shipped template matches its contract, so drift fails the build.
 */
import type { ReactElement } from 'react';
import WelcomeEmail from '@/emails/welcome';
import VerifyEmail from '@/emails/verify-email';
import ResetPasswordEmail from '@/emails/reset-password';
import InvitationEmail from '@/emails/invitation';
import { emailOverrides } from '@/lib/app/emails';

/**
 * The typed props contract per email kind. Keys are the {@link EmailKind}
 * union; each value is exactly what the platform passes to that template and
 * what an override must accept.
 */
export interface EmailPropsMap {
  welcome: { userName: string; userEmail: string; baseUrl: string };
  verifyEmail: { userName: string; verificationUrl: string; expiresAt: Date };
  resetPassword: { userName: string; resetUrl: string; expiresAt: Date };
  invitation: {
    inviterName: string;
    inviteeName: string;
    inviteeEmail: string;
    invitationUrl: string;
    expiresAt: Date;
  };
}

/** The set of overridable auth emails. */
export type EmailKind = keyof EmailPropsMap;

/** A template for a given kind: takes that kind's props, returns an element. */
export type EmailTemplate<K extends EmailKind> = (props: EmailPropsMap[K]) => ReactElement;

/**
 * Per-kind override map. A fork populates this (in `lib/app/emails.ts`); unset
 * kinds fall back to the platform default.
 */
export type EmailOverrides = { [K in EmailKind]?: EmailTemplate<K> };

/**
 * Platform default templates. The explicit `EmailTemplate<K>` mapped type makes
 * this assignment the enforcement point: if a template's props drift from
 * {@link EmailPropsMap}, this fails to type-check.
 */
const defaultTemplates: { [K in EmailKind]: EmailTemplate<K> } = {
  welcome: WelcomeEmail,
  verifyEmail: VerifyEmail,
  resetPassword: ResetPasswordEmail,
  invitation: InvitationEmail,
};

/**
 * Render an email template for `kind`: the fork override if one is registered,
 * else the platform default. Returns the rendered element ready for `sendEmail`.
 */
export function resolveEmailTemplate<K extends EmailKind>(
  kind: K,
  props: EmailPropsMap[K]
): ReactElement {
  const override = emailOverrides[kind];
  const template = override ?? defaultTemplates[kind];
  return template(props);
}
