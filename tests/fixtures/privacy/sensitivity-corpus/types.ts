/**
 * The shape of the synthetic confidential-content corpus (§130, t-1036).
 *
 * Every message is invented. Each is something a user might type to an agent,
 * labelled with every category of confidential content it discloses, or with
 * none: business text that must NOT flag is as much the point as text that
 * must.
 */
import type { CoreSensitivityCategory } from '@/lib/privacy/adapters/types';

export interface SensitivityCorpusCase {
  id: string;
  /** One user message, as typed. */
  text: string;
  /** Every category the message discloses; `[]` for a message that must not flag. */
  categories: CoreSensitivityCategory[];
}
