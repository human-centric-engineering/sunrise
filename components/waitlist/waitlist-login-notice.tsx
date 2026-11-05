import Link from 'next/link';

import { getWaitlistConfig } from '@/lib/waitlist/config';

/**
 * What the login page says to someone without an account while sign-up is by
 * invitation and the app has a waitlist (§125 t-978).
 *
 * Under `SIGNUP_MODE=invite_only` the login page hides its sign-up link and
 * `/signup` redirects here, so someone who came to sign up lands on "Welcome
 * back" with no way in and no reason given. With a waitlist, the way in is the
 * list: this line points at it (`joinPath` in the config, default `/`).
 *
 * Renders nothing without a waitlist config. The page decides `invite_only`.
 */
export function WaitlistLoginNotice() {
  const config = getWaitlistConfig();
  if (!config) return null;
  return (
    <p className="text-muted-foreground text-center text-sm">
      Accounts are by invitation for now.{' '}
      <Link href={config.joinPath} className="text-primary font-medium hover:underline">
        Join the waitlist
      </Link>{' '}
      to hear when we open.
    </p>
  );
}
