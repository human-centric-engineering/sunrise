/**
 * `<Waitlist />` — the waitlist form, ready to mount on any page (§125).
 *
 * A server component: it reads the app's waitlist config and each list's open
 * state and renders `<WaitlistForm>` with them — the same answer
 * `GET /api/v1/waitlist` gives, built by the same functions. With no waitlist
 * it renders nothing, so a page that mounts it is unaffected until the app has
 * one; and a failure to read the state renders nothing and logs, rather than
 * breaking the page.
 *
 * **Why it does not call the API.** The rule is that a component reads through
 * the API. This one would call a public route that is rate-limited by IP, from
 * the server, so every visitor's render shares one bucket — the server's
 * egress address once an edge proxy rewrites `x-forwarded-for` — and a busy
 * launch page loses its form to a 429 (§125 review). The capability stays
 * API-accessible; the page just doesn't take the HTTP hop to reach it.
 *
 *   <Waitlist
 *     copy={{
 *       submitLabel: 'Get early access',
 *       consentNotice: <>We’ll email you about the launch. <a href="/privacy">Privacy</a></>,
 *     }}
 *   />
 *
 * It reads the database on every render, so the page it is on renders per
 * request.
 */

import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { toWaitlistFieldShape } from '@/lib/validations/waitlist';
import { getWaitlistConfig } from '@/lib/waitlist/config';
import { getWaitlistListStatuses, type WaitlistListStatus } from '@/lib/waitlist/lists';
import { WaitlistForm, type WaitlistFormCopy } from '@/components/waitlist/waitlist-form';

export interface WaitlistProps {
  /** Which list to join. Default: the first the app declares. */
  list?: string;
  copy?: Partial<WaitlistFormCopy>;
  className?: string;
}

export async function Waitlist({ list, copy, className }: WaitlistProps) {
  const config = getWaitlistConfig();
  if (!config) return null;

  let lists: WaitlistListStatus[];
  try {
    // The org the join route writes into.
    lists = await runAsOrg(INSTALL_ORG_ID, () => getWaitlistListStatuses(config), {
      source: 'public-form',
    });
  } catch (error) {
    logger.error('<Waitlist> could not read the waitlist', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const target = list === undefined ? lists[0] : lists.find((l) => l.key === list);
  if (!target) {
    logger.warn('<Waitlist> names a list the waitlist config does not declare', { list });
    return null;
  }

  return (
    <WaitlistForm
      fields={config.fields.map(toWaitlistFieldShape)}
      list={target.key}
      closed={!target.open}
      copy={copy}
      className={className}
    />
  );
}
