/**
 * `<Waitlist />` — the waitlist form, ready to mount on any page (§125).
 *
 * A server component: it asks `GET /api/v1/waitlist` for the lists and the
 * form's fields and renders `<WaitlistForm>` with them. When the app has no
 * waitlist the route answers 404 and this renders nothing, so a page that
 * mounts it is unaffected until the app has one.
 *
 *   <Waitlist
 *     copy={{
 *       submitLabel: 'Get early access',
 *       consentNotice: <>We’ll email you about the launch. <a href="/privacy">Privacy</a></>,
 *     }}
 *   />
 *
 * It fetches on every render, so the page it is on renders per request.
 */

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { waitlistStatusSchema } from '@/lib/validations/waitlist';
import { WaitlistForm, type WaitlistFormCopy } from '@/components/waitlist/waitlist-form';

export interface WaitlistProps {
  /** Which list to join. Default: the first the app declares. */
  list?: string;
  copy?: Partial<WaitlistFormCopy>;
  className?: string;
}

export async function Waitlist({ list, copy, className }: WaitlistProps) {
  const res = await serverFetch(API.PUBLIC.WAITLIST);
  // No waitlist: nothing to render, and nothing to report.
  if (res.status === 404) return null;
  if (!res.ok) {
    logger.error('<Waitlist> could not read the waitlist', { status: res.status });
    return null;
  }

  const body = await parseApiResponse<unknown>(res);
  const status = body.success ? waitlistStatusSchema.safeParse(body.data) : null;
  if (!status?.success) {
    logger.error('<Waitlist> got a waitlist response it could not read');
    return null;
  }

  const { lists, fields } = status.data;
  const target = list === undefined ? lists[0] : lists.find((l) => l.key === list);
  if (!target) {
    logger.warn('<Waitlist> names a list the waitlist config does not declare', { list });
    return null;
  }

  return (
    <WaitlistForm
      fields={fields}
      list={target.key}
      closed={!target.open}
      copy={copy}
      className={className}
    />
  );
}
