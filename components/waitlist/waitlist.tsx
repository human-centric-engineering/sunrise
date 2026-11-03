/**
 * `<Waitlist />` — the waitlist form, ready to mount on any page (§125).
 *
 * A server component: it reads the app's waitlist config and whether the list
 * is open, and renders `<WaitlistForm>` with them. With no waitlist config it
 * renders nothing, so a page that mounts it is unaffected until the app has
 * one.
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
import { getWaitlistConfig } from '@/lib/waitlist/config';
import { isWaitlistListOpen } from '@/lib/waitlist/lists';
import { WaitlistForm, type WaitlistFormCopy } from '@/components/waitlist/waitlist-form';

export interface WaitlistProps {
  /** Which list to join. Default: the first the config declares. */
  list?: string;
  copy?: Partial<WaitlistFormCopy>;
  className?: string;
}

export async function Waitlist({ list, copy, className }: WaitlistProps) {
  const config = getWaitlistConfig();
  if (!config) return null;

  const key = list ?? config.lists[0]?.key;
  if (!key || !config.lists.some((l) => l.key === key)) {
    logger.warn('<Waitlist> names a list the waitlist config does not declare', { list: key });
    return null;
  }

  // The same org the join route writes into.
  const open = await runAsOrg(INSTALL_ORG_ID, () => isWaitlistListOpen(config, key), {
    source: 'public-form',
  });

  // Only the serialisable parts of each field cross to the client.
  const fields = config.fields.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    ...(f.help !== undefined ? { help: f.help } : {}),
    ...(f.options !== undefined ? { options: f.options.map((o) => ({ ...o })) } : {}),
    ...(f.required !== undefined ? { required: f.required } : {}),
    ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
  }));

  return (
    <WaitlistForm fields={fields} list={key} closed={!open} copy={copy} className={className} />
  );
}
