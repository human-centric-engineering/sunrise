/**
 * App waitlist config (§125).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * `null` means this app has no waitlist: the join route answers 404, the admin
 * page is hidden and nothing writes. Fill it in to have one. Each list starts
 * open (or `startsClosed`); after that an admin opens and closes it on
 * /admin/waitlist, and the stored state wins over this file.
 *
 *   import type { WaitlistConfig } from '@/lib/waitlist/config';
 *
 *   export const waitlistConfig: WaitlistConfig | null = {
 *     consentVersion: '2026-11-01',          // the version of your privacy notice
 *     fields: [
 *       { key: 'role', label: 'What do you do?', kind: 'select',
 *         options: [{ value: 'producer', label: 'Producer' }, { value: 'dj', label: 'DJ' }] },
 *       { key: 'useCase', label: 'What would you use it for?', kind: 'textarea' },
 *     ],
 *     screen: ({ email }) =>
 *       email.endsWith('@mailinator.com') ? { action: 'flag', reason: 'disposable-domain' }
 *                                         : { action: 'accept' },
 *   };
 *
 * Then mount `<Waitlist />` (`@/components/waitlist/waitlist`) on whatever page
 * you like, with your own copy. Your privacy notice must cover what the form
 * collects and how long it is kept.
 *
 * Full guide: .context/waitlist/overview.md · CUSTOMIZATION.md §4
 */
import type { WaitlistConfig } from '@/lib/waitlist/config';

export const waitlistConfig: WaitlistConfig | null = null;
