/**
 * The schema factories take their messages from the translator they are
 * given (§138 t-1073), and the exported constants are the source English.
 */

import { describe, expect, it } from 'vitest';
import en from '@/lib/i18n/messages/en.json';
import { englishValidation, type ValidationT } from '@/lib/validations/messages';
import { createSignInSchema, createSignUpSchema, signUpSchema } from '@/lib/validations/auth';
import { createUpdateUserSchema } from '@/lib/validations/user';
import { createContactClientSchema } from '@/lib/validations/contact';
import { buildWaitlistDetailsSchema } from '@/lib/validations/waitlist';
import {
  buildSupportGrantSchema,
  createInviteOrgMemberSchema,
  createSaveProviderKeySchema,
  createSupportGrantSchema,
  inviteOrgMemberSchema,
  PROVIDER_KEY_MAX_LENGTH,
  saveProviderKeySchema,
  SUPPORT_GRANT_MAX_HOURS,
} from '@/lib/validations/tenancy';

/** A translator that shows which key and values it was asked for. */
const keyed: ValidationT = (key, values) =>
  values ? `${key}:${JSON.stringify(values)}` : `[${key}]`;

function messagesOf(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((i) => i.message) ?? [];
}

describe('englishValidation', () => {
  it('reads the source catalogue', () => {
    expect(englishValidation('emailInvalid')).toBe(en.validation.emailInvalid);
  });

  it('fills ICU arguments', () => {
    expect(englishValidation('answerTooLong', { label: 'Company', max: '200' })).toBe(
      'Company must be 200 characters or fewer'
    );
  });
});

describe('schema factories', () => {
  it('take every message from the given translator', () => {
    const result = createSignUpSchema(keyed).safeParse({
      email: 'not-an-email',
      password: 'short',
      name: '',
      confirmPassword: 'other',
    });

    expect(messagesOf(result)).toEqual(
      expect.arrayContaining([
        '[emailInvalid]',
        '[passwordTooShort]',
        '[nameRequired]',
        '[passwordsDontMatch]',
      ])
    );
    expect(messagesOf(result).every((m) => m.startsWith('['))).toBe(true);
  });

  it('covers sign-in, profile and contact', () => {
    expect(messagesOf(createSignInSchema(keyed).safeParse({ email: '', password: '' }))).toContain(
      '[passwordRequired]'
    );
    expect(messagesOf(createUpdateUserSchema(keyed).safeParse({ phone: 'abc' }))).toEqual([
      '[phoneInvalid]',
    ]);
    expect(
      messagesOf(
        createContactClientSchema(keyed).safeParse({
          name: 'A',
          email: 'a@b.co',
          subject: 'S',
          message: 'short',
        })
      )
    ).toEqual(['[messageTooShort]']);
  });

  it("pass a waitlist field's own label through as given", () => {
    const schema = buildWaitlistDetailsSchema(
      [{ key: 'company', label: 'Company', kind: 'text', required: true }],
      keyed
    );

    expect(messagesOf(schema.safeParse({ company: '' }))).toEqual([
      'answerRequired:{"label":"Company"}',
    ]);
  });

  it('build the exported constants in the source English', () => {
    const result = signUpSchema.safeParse({
      email: 'a@b.co',
      password: 'Password1!',
      name: 'A',
      confirmPassword: 'different',
    });

    expect(messagesOf(result)).toEqual(["Passwords don't match"]);
  });

  // The org-settings admin forms (§138 t-1074).
  it('cover the invite, support-grant and AI-key forms', () => {
    expect(
      messagesOf(createInviteOrgMemberSchema(keyed).safeParse({ name: '', email: 'nope' }))
    ).toEqual(['[nameRequired]', '[emailInvalid]']);
    expect(
      messagesOf(buildSupportGrantSchema(keyed).safeParse({ reason: '', durationHours: 1.5 }))
    ).toEqual(['[supportReasonRequired]', '[durationWhole]']);
    expect(
      messagesOf(
        buildSupportGrantSchema(keyed).safeParse({
          reason: 'x',
          durationHours: SUPPORT_GRANT_MAX_HOURS + 1,
        })
      )
    ).toEqual([`durationTooLong:{"max":"${SUPPORT_GRANT_MAX_HOURS}"}`]);
    expect(messagesOf(createSaveProviderKeySchema(keyed).safeParse({ apiKey: 'a b' }))).toEqual([
      '[providerKeyBadCharacter]',
    ]);
  });

  it('keep the English the tenancy routes have always returned', () => {
    expect(messagesOf(inviteOrgMemberSchema.safeParse({ name: '', email: 'a@b.co' }))).toEqual([
      'Name is required',
    ]);
    expect(
      messagesOf(
        createSupportGrantSchema.safeParse({
          reason: 'x',
          durationHours: SUPPORT_GRANT_MAX_HOURS + 1,
        })
      )
    ).toEqual([`Duration must be at most ${SUPPORT_GRANT_MAX_HOURS} hours`]);
    expect(
      messagesOf(
        saveProviderKeySchema.safeParse({ apiKey: 'k'.repeat(PROVIDER_KEY_MAX_LENGTH + 1) })
      )
    ).toEqual([`A key is at most ${PROVIDER_KEY_MAX_LENGTH} characters`]);
  });
});
