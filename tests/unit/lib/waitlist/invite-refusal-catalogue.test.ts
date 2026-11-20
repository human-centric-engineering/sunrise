/**
 * A waitlist refusal reads the same on the page as from the route (§138 t-1074).
 *
 * The single-invite route answers 409 with `WAITLIST_INVITE_REFUSAL_MESSAGES`,
 * English whoever asked. The admin page reads the same reason from the
 * catalogue (`admin.waitlist.refusals`), so it follows the viewer's language.
 * This holds the two to one set of reasons and, in the source English, to
 * one wording: a reason added to `WAITLIST_INVITE_REFUSALS` without its
 * catalogue entry, or a sentence edited in one place only, fails here.
 */
import { describe, expect, it } from 'vitest';
import en from '@/lib/i18n/messages/en.json';
import {
  WAITLIST_INVITE_REFUSAL_MESSAGES,
  WAITLIST_INVITE_REFUSALS,
} from '@/lib/waitlist/invite-refusals';

describe('admin.waitlist.refusals', () => {
  it('has every refusal, and no other', () => {
    expect(Object.keys(en.admin.waitlist.refusals).sort()).toEqual(
      [...WAITLIST_INVITE_REFUSALS].sort()
    );
  });

  it('words each one as the route does, in the source English', () => {
    expect(en.admin.waitlist.refusals).toEqual(WAITLIST_INVITE_REFUSAL_MESSAGES);
  });
});
