// @vitest-environment happy-dom

/**
 * What the credential forms do before the page's JavaScript runs (t-998).
 *
 * The defect lives in the markup the server sends, so these read that markup
 * with `renderToString`. A client render cannot show it: `<noscript>` renders
 * nothing there, and React has already taken over the submit.
 *
 * @see components/forms/no-script-notice.tsx
 */

import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearchParams } from 'next/navigation';

import { AcceptInviteForm } from '@/components/forms/accept-invite-form';
import { ContactForm } from '@/components/forms/contact-form';
import { LoginForm } from '@/components/forms/login-form';
import { NoScriptNotice } from '@/components/forms/no-script-notice';
import { PasswordForm } from '@/components/forms/password-form';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';
import { SignupForm } from '@/components/forms/signup-form';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(),
  usePathname: vi.fn(() => '/'),
}));

vi.mock('@/lib/auth/client', () => ({
  authClient: { signIn: {}, signUp: {}, getSession: vi.fn(), useSession: vi.fn() },
  useSession: vi.fn(() => ({ data: null, isPending: false })),
}));

const NOTICE = 'This form needs JavaScript.';

function formTags(element: ReactElement): string[] {
  return renderToString(element).match(/<form[^>]*>/g) ?? [];
}

describe('forms submitted before the page has loaded', () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
  });

  describe.each<[string, () => ReactElement, string?]>([
    ['sign-in', () => <LoginForm />],
    ['sign-up', () => <SignupForm />],
    ['reset request', () => <ResetPasswordForm />],
    ['reset completion', () => <ResetPasswordForm />, 'token=reset-token'],
    ['password change', () => <PasswordForm />],
    ['contact', () => <ContactForm />],
  ])('the %s form', (_name, build, query) => {
    beforeEach(() => {
      if (!query) return;
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>
      );
    });

    it('is sent by POST, so a browser cannot put its fields in the URL', () => {
      const tags = formTags(build());

      expect(tags).toHaveLength(1);
      expect(tags[0]).toContain('method="post"');
    });

    it('tells someone with no JavaScript that it cannot work', () => {
      expect(renderToString(build())).toContain(NOTICE);
    });
  });

  describe('the invitation form', () => {
    beforeEach(() => {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=invite-token&email=a@b.c') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
    });

    it('sends no form from the server: it appears only once the invitation has loaded', () => {
      expect(formTags(<AcceptInviteForm />)).toEqual([]);
    });

    it('tells someone with no JavaScript, who would otherwise wait on the loading state', () => {
      expect(renderToString(<AcceptInviteForm />)).toContain(NOTICE);
    });
  });
});

describe('NoScriptNotice', () => {
  it('keeps its message inside <noscript>, so a running browser never shows it', () => {
    expect(renderToString(<NoScriptNotice />)).toMatch(
      new RegExp(`^<noscript>.*${NOTICE}.*</noscript>$`)
    );
  });
});
