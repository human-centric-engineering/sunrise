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
import ChangeEmailApprovalEmail from '@/emails/change-email-approval';
import WaitlistConfirmEmail from '@/emails/waitlist-confirm';
import WaitlistAlreadyOnListEmail from '@/emails/waitlist-already-on-list';
import { emailOverrides } from '@/lib/app/emails';

/**
 * The typed props contract per email kind. Keys are the {@link EmailKind}
 * union; each value is exactly what the platform passes to that template and
 * what an override must accept.
 *
 * ## Adding your own email kind (forks)
 *
 * This is an `interface`, so a fork **adds** kinds by declaration merging — no
 * edit to this file, nothing to conflict on upgrade. Declare the merge and the
 * template in your own module:
 *
 * ```ts
 * // lib/app/emails.ts (or any module your app loads)
 * declare module '@/lib/email/registry' {
 *   interface EmailPropsMap {
 *     'app.invoiceReceipt': { userName: string; invoiceUrl: string; total: string };
 *   }
 * }
 *
 * export const emailOverrides: EmailOverrides = {
 *   'app.invoiceReceipt': InvoiceReceiptEmail,
 * };
 * ```
 *
 * `EmailKind`, `EmailOverrides` and `resolveEmailTemplate` all widen with it, so
 * `resolveEmailTemplate('app.invoiceReceipt', props)` is type-checked against
 * your declared props. Namespace your keys `app.` / `framework.` to match the
 * reserved tiers in CUSTOMIZATION.md and guarantee no collision with a kind a
 * future Sunrise release adds.
 *
 * A fork-added kind has no platform default — it exists only in
 * `emailOverrides` — which is why `defaultTemplates` below is `Partial` and
 * `resolveEmailTemplate` throws for a kind with neither. See #468.
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
    /** The org the invitation joins. Absent ⇒ the email names the app (#1199). */
    orgName?: string;
    /**
     * The address already has an account: the email asks them to sign in and
     * accept, not to set a password. An override that ignores it sends an
     * existing user to a page that will ask them to sign in anyway.
     */
    hasAccount?: boolean;
  };
  /**
   * Sent to the address currently on the account when a change to a new one is
   * requested. Nothing changes until the recipient approves, so a fork that
   * overrides this must keep both the approval link and the "you didn't request
   * this" path — it is the control that stops a stolen session from taking the
   * account (#489).
   */
  changeEmailApproval: {
    userName: string;
    currentEmail: string;
    newEmail: string;
    approvalUrl: string;
    expiresAt: Date;
  };
  /**
   * The waitlist confirmation (§125 t-977), sent to an address nobody has
   * proved. `firstName` is a first name or null, never the form's raw text —
   * the platform filters it, because a URL typed as a name would otherwise
   * arrive as a link from the app's real sender. An override must keep both
   * links: the leave link is how someone who never joined gets off the list.
   */
  waitlistConfirm: {
    firstName: string | null;
    confirmUrl: string;
    leaveUrl: string;
    expiresAt: Date;
  };
  /**
   * Sent instead of a confirmation when an already-confirmed address is
   * submitted again (§125 t-977). No confirm link; keep the leave link.
   */
  waitlistAlreadyOnList: {
    firstName: string | null;
    leaveUrl: string;
  };
}

/** The set of overridable platform emails (auth, and the waitlist's two). */
export type EmailKind = keyof EmailPropsMap;

/** A template for a given kind: takes that kind's props, returns an element. */
export type EmailTemplate<K extends EmailKind> = (props: EmailPropsMap[K]) => ReactElement;

/**
 * Per-kind override map. A fork populates this (in `lib/app/emails.ts`); unset
 * kinds fall back to the platform default.
 */
export type EmailOverrides = { [K in EmailKind]?: EmailTemplate<K> };

/**
 * Platform default templates. The explicit `EmailTemplate<K>` mapped type keeps
 * this the enforcement point: if a template's props drift from
 * {@link EmailPropsMap}, this fails to type-check.
 *
 * `Partial` because a fork can add kinds by declaration merging (#468) and those
 * have no platform default — they live only in `emailOverrides`. A total mapped
 * type would make every fork-added kind a compile error here, in a platform file
 * the fork cannot edit without a conflict.
 */
const defaultTemplates: { [K in EmailKind]?: EmailTemplate<K> } = {
  welcome: WelcomeEmail,
  verifyEmail: VerifyEmail,
  resetPassword: ResetPasswordEmail,
  invitation: InvitationEmail,
  changeEmailApproval: ChangeEmailApprovalEmail,
  waitlistConfirm: WaitlistConfirmEmail,
  waitlistAlreadyOnList: WaitlistAlreadyOnListEmail,
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
  if (!template) {
    // Reachable only for a fork-declared kind (#468) with no override supplied —
    // the type system cannot catch that, because declaration merging widens
    // `EmailKind` without requiring an entry anywhere. Throw naming the kind
    // rather than returning nothing: a caller that renders `undefined` sends a
    // blank email, which is far harder to diagnose than a failed send.
    throw new Error(
      `No email template for kind "${String(kind)}". Register it in emailOverrides (lib/app/emails.ts).`
    );
  }
  return template(props);
}
