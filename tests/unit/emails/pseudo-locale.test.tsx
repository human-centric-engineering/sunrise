/**
 * Every email is written from the catalogue (§138 t-1075).
 *
 * Each template in `emails/` is rendered under the pseudo-locale, where every
 * catalogue string comes out accented and bracketed (`Verify Email` →
 * `[Ṽéŕîƒý Éɱåîļ]`). Take away the bracketed text and the values the test
 * passed in, and nothing should be left: English that survives is copy that
 * was never moved into the catalogue. The preview line is checked too, since
 * it is what an inbox shows before the email is opened.
 *
 * The list of templates is read from the directory, so a template added to
 * `emails/` without a case here fails the test rather than going unchecked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import ChangeEmailApproval from '@/emails/change-email-approval';
import CleanupReady from '@/emails/cleanup-ready';
import ContactNotificationEmail from '@/emails/contact-notification';
import EscalationNotification from '@/emails/escalation-notification';
import EventNotification, { eventNotificationSubject } from '@/emails/event-notification';
import InvitationEmail from '@/emails/invitation';
import ResetPasswordEmail from '@/emails/reset-password';
import UsageNoticeEmail from '@/emails/usage-notice';
import VerifyEmail from '@/emails/verify-email';
import WaitlistAlreadyOnListEmail from '@/emails/waitlist-already-on-list';
import WaitlistConfirmEmail from '@/emails/waitlist-confirm';
import WelcomeEmail from '@/emails/welcome';
import WorkflowNotification from '@/emails/workflow-notification';
import { emailTranslator } from '@/lib/email/translate';
import { messagesFor } from '@/lib/i18n/catalogue';
import { PSEUDO_LOCALE } from '@/lib/i18n/locales';

const where = { locale: PSEUDO_LOCALE, timeZone: 'UTC' };

/**
 * Values the test passes in. None is a word of English: whatever is left of
 * them after a render is data, and they are taken out before the check.
 */
const V = {
  name: 'Q1',
  other: 'Q2',
  email: 'q3@example.test',
  url: 'https://example.test/q4',
  org: 'Q5',
  text: 'Q6',
  date: new Date('2026-11-20T10:00:00Z'),
};
const PASSED_IN = [V.name, V.other, V.email, V.url, V.org, V.text];

/** The event payload's own field name, shown as the event names it (data, not copy). */
const PAYLOAD_LABELS = ['Workflow name'];

const TEMPLATES: Record<string, () => ReactElement> = {
  'change-email-approval': () =>
    ChangeEmailApproval({
      userName: V.name,
      currentEmail: V.email,
      newEmail: V.email,
      approvalUrl: V.url,
      expiresAt: V.date,
      ...where,
    }),
  'usage-notice': () =>
    UsageNoticeEmail({
      orgName: V.org,
      meterLabel: V.other,
      threshold: 'near',
      used: 8,
      allowance: 10,
      money: false,
      billingUrl: V.url,
      ...where,
    }),
  'cleanup-ready': () =>
    CleanupReady({
      documentName: V.text,
      cleanupUrl: V.url,
      sizeClass: 'medium',
      sizeTokens: 1234,
      ...where,
    }),
  'contact-notification': () =>
    ContactNotificationEmail({
      name: V.name,
      email: V.email,
      subject: V.other,
      message: V.text,
      submittedAt: V.date,
      ...where,
    }),
  'escalation-notification': () =>
    EscalationNotification({
      agentName: V.name,
      reason: V.text,
      priority: 'high',
      conversationId: 'c1',
      appUrl: 'https://example.test',
      ...where,
    }),
  'event-notification': () =>
    EventNotification({
      event: 'approval_required',
      timestamp: V.date.toISOString(),
      data: { workflowName: V.name, approveUrl: V.url, rejectUrl: V.url },
      ...where,
    }),
  invitation: () =>
    InvitationEmail({
      inviterName: V.name,
      inviteeName: V.other,
      inviteeEmail: V.email,
      invitationUrl: V.url,
      expiresAt: V.date,
      orgName: V.org,
      ...where,
    }),
  'reset-password': () =>
    ResetPasswordEmail({ userName: V.name, resetUrl: V.url, expiresAt: V.date, ...where }),
  'verify-email': () =>
    VerifyEmail({ userName: V.name, verificationUrl: V.url, expiresAt: V.date, ...where }),
  'waitlist-already-on-list': () =>
    WaitlistAlreadyOnListEmail({ firstName: V.name, leaveUrl: V.url, ...where }),
  'waitlist-confirm': () =>
    WaitlistConfirmEmail({
      firstName: V.name,
      confirmUrl: V.url,
      leaveUrl: V.url,
      expiresAt: V.date,
      ...where,
    }),
  welcome: () => WelcomeEmail({ userName: V.name, userEmail: V.email, baseUrl: V.url, ...where }),
  'workflow-notification': () =>
    WorkflowNotification({ body: V.text, workflowName: V.name, ...where }),
};

/** The text a reader sees, preview line included: tags, styles and the head gone. */
async function visibleText(element: ReactElement): Promise<string> {
  const html = await render(element);
  return html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#xa0;/gi, ' ')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** What is left once the catalogue's text and the values passed in are taken away. */
function leftover(text: string): string[] {
  let rest = text.replace(/\[[^\]]*\]/g, ' ');
  for (const value of [...PASSED_IN, ...PAYLOAD_LABELS]) rest = rest.split(value).join(' ');
  return rest.match(/[A-Za-z]{2,}/g) ?? [];
}

describe('every email under the pseudo-locale', () => {
  const files = fs
    .readdirSync(path.join(process.cwd(), 'emails'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();

  it('has a case here for every template in emails/', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(files);
  });

  it.each(Object.keys(TEMPLATES))('%s has no English that is not from the catalogue', async (k) => {
    const text = await visibleText(TEMPLATES[k]());
    // It did render the catalogue's copy, not an empty body.
    expect(text).toMatch(/\[[^\]]*[ÅÉÎÖÛåéîöûšţñ][^\]]*\]/);
    expect(leftover(text)).toEqual([]);
  });

  it.each(Object.keys(TEMPLATES))('%s declares its language on the document', async (k) => {
    const html = await render(TEMPLATES[k]());
    expect(html).toContain(`lang="${PSEUDO_LOCALE}"`);
  });
});

describe('every email subject under the pseudo-locale', () => {
  // The send sites build their subject from `emails.<kind>.subject`; the
  // event email's comes from its own builder.
  const catalogue = messagesFor(PSEUDO_LOCALE).emails;
  const withSubject = Object.entries(catalogue).filter(
    ([, strings]) => typeof strings === 'object' && 'subject' in strings
  );

  it('has a subject for every email the platform names one for', () => {
    expect(withSubject.map(([kind]) => kind).sort()).toEqual(
      [
        'changeEmailApproval',
        'cleanupReady',
        'contactNotification',
        'escalationNotification',
        'eventNotification',
        'invitation',
        'resetPassword',
        'usageNotice',
        'verifyEmail',
        'waitlistAlreadyOnList',
        'waitlistConfirm',
        'welcome',
      ].sort()
    );
  });

  it('translates every subject', () => {
    const t = emailTranslator(where, 'emails');
    const subjects = [
      t('welcome.subject', { brand: V.org }),
      t('verifyEmail.subject'),
      t('resetPassword.subject'),
      t('invitation.subject', { org: V.org }),
      t('changeEmailApproval.subject'),
      t('waitlistConfirm.subject', { brand: V.org }),
      t('waitlistAlreadyOnList.subject', { brand: V.org }),
      t('contactNotification.subject', { brand: V.org, subject: V.other }),
      t('cleanupReady.subject', { name: V.text }),
      t('usageNotice.subject', { org: V.org, meter: V.other, threshold: 'near' }),
      t('usageNotice.subject', { org: V.org, meter: V.other, threshold: 'reached' }),
      t('escalationNotification.subject', { priority: V.other, reason: V.text }),
      t('eventNotification.testSubject', { brand: V.org }),
      eventNotificationSubject('workflow_failed', { workflowName: V.name }, where),
      eventNotificationSubject('some_new_event', {}, where),
    ];
    for (const subject of subjects) expect(leftover(subject)).toEqual([]);
  });
});
