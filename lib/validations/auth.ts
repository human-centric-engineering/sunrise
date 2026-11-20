import { z } from 'zod';
import { englishValidation, type ValidationT } from '@/lib/validations/messages';

/**
 * Password validation schema
 *
 * Enforces strong password requirements:
 * - Minimum 8 characters
 * - Maximum 100 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 *
 * Based on NIST password guidelines with a balance between security and usability.
 *
 * Each schema a form shows has a `create…Schema(t)` factory: a form passes
 * `useTranslations('validation')` so its errors read in the viewer's
 * language, and the exported constant is the same schema in the source
 * catalogue's English, which is what the API returns (§138 t-1073,
 * `lib/validations/messages.ts`).
 */
export function createPasswordSchema(t: ValidationT): z.ZodString {
  return z
    .string()
    .min(8, t('passwordTooShort'))
    .max(100, t('passwordTooLong'))
    .regex(/[A-Z]/, t('passwordUppercase'))
    .regex(/[a-z]/, t('passwordLowercase'))
    .regex(/[0-9]/, t('passwordNumber'))
    .regex(/[^A-Za-z0-9]/, t('passwordSpecial'));
}
export const passwordSchema = createPasswordSchema(englishValidation);

/**
 * Email validation schema
 *
 * Validates and normalizes email addresses:
 * - Must be a valid email format
 * - Maximum 255 characters
 * - Converted to lowercase
 * - Whitespace trimmed
 */
export function createEmailSchema(t: ValidationT): z.ZodString {
  return z
    .string()
    .trim()
    .toLowerCase()
    .min(1, t('emailRequired'))
    .email(t('emailInvalid'))
    .max(255, t('emailTooLong'));
}
export const emailSchema = createEmailSchema(englishValidation);

/**
 * Sign-up validation schema
 *
 * Validates user registration data
 */
export function createSignUpSchema(t: ValidationT): z.ZodObject<{
  email: z.ZodString;
  password: z.ZodString;
  name: z.ZodString;
  confirmPassword: z.ZodString;
}> {
  return z
    .object({
      email: createEmailSchema(t),
      password: createPasswordSchema(t),
      name: z.string().trim().min(1, t('nameRequired')).max(100, t('nameTooLong')),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t('passwordsDontMatch'),
      path: ['confirmPassword'],
    });
}
export const signUpSchema = createSignUpSchema(englishValidation);

/**
 * Sign-in validation schema
 *
 * Validates user login data
 */
export function createSignInSchema(
  t: ValidationT
): z.ZodObject<{ email: z.ZodString; password: z.ZodString }> {
  return z.object({
    email: createEmailSchema(t),
    password: z.string().min(1, t('passwordRequired')).max(100), // Don't validate password strength on login
  });
}
export const signInSchema = createSignInSchema(englishValidation);

/**
 * Change password validation schema
 *
 * Validates password change requests
 */
export function createChangePasswordSchema(t: ValidationT): z.ZodObject<{
  currentPassword: z.ZodString;
  newPassword: z.ZodString;
  confirmPassword: z.ZodString;
}> {
  return z
    .object({
      currentPassword: z.string().min(1, t('currentPasswordRequired')),
      newPassword: createPasswordSchema(t),
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: t('passwordsDontMatch'),
      path: ['confirmPassword'],
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
      message: t('newPasswordSameAsCurrent'),
      path: ['newPassword'],
    });
}
export const changePasswordSchema = createChangePasswordSchema(englishValidation);

/**
 * Password reset request validation schema
 *
 * Validates password reset request (forgot password)
 */
export function createResetPasswordRequestSchema(
  t: ValidationT
): z.ZodObject<{ email: z.ZodString }> {
  return z.object({ email: createEmailSchema(t) });
}
export const resetPasswordRequestSchema = createResetPasswordRequestSchema(englishValidation);

/**
 * Password reset validation schema
 *
 * Validates password reset with token
 */
export function createResetPasswordSchema(t: ValidationT): z.ZodObject<{
  token: z.ZodString;
  password: z.ZodString;
  confirmPassword: z.ZodString;
}> {
  return z
    .object({
      token: z.string().min(1, t('resetTokenRequired')),
      password: createPasswordSchema(t),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t('passwordsDontMatch'),
      path: ['confirmPassword'],
    });
}
export const resetPasswordSchema = createResetPasswordSchema(englishValidation);

/**
 * Email verification schema
 *
 * Validates email verification token
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, englishValidation('verificationTokenRequired')),
});

/**
 * Send verification email schema
 *
 * Validates request to send a verification email
 */
export const sendVerificationEmailSchema = z.object({
  email: emailSchema,
});

/**
 * TypeScript types inferred from schemas
 * Use these for type-safe form handling
 */
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordRequestInput = z.infer<typeof resetPasswordRequestSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type SendVerificationEmailInput = z.infer<typeof sendVerificationEmailSchema>;
