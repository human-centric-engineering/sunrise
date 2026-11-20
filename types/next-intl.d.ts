/**
 * Type-safe message keys and named formats for next-intl (§138 t-1071).
 *
 * `t('common.save')` type-checks only if the key is in the source catalogue
 * (`lib/i18n/messages/en.json`), and `format.dateTime(d, 'short')` only if
 * the format is in `I18N_FORMATS`. A missing key fails `npm run type-check`,
 * not a page at runtime.
 */
import type { Messages } from '@/lib/i18n/catalogue';
import type { I18N_FORMATS } from '@/lib/i18n/format';

declare module 'next-intl' {
  interface AppConfig {
    Messages: Messages;
    Formats: typeof I18N_FORMATS;
  }
}
