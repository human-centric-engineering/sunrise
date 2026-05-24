/**
 * SMS opt-out / opt-in keyword detection.
 *
 * Regulated by US TCPA and UK PECR — carriers expect platforms to honour
 * the standard keywords. STOP / UNSUBSCRIBE / CANCEL / END / QUIT must
 * suppress future outbound; START / UNSTOP / YES must re-enable; HELP /
 * INFO is informational (no opt-state change).
 *
 * Match is **whole-word first-token only** (case-insensitive), per the
 * regulatory norm — a message like "I don't want to STOP using this
 * service" does NOT count as an opt-out. The first non-whitespace token
 * is what matters.
 *
 * Punctuation immediately after the token is stripped (so "STOP." matches)
 * because users routinely add a full stop.
 */

const OPT_OUT = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'STOPALL', 'OPTOUT']);
const OPT_IN = new Set(['START', 'UNSTOP', 'YES', 'OPTIN']);
const INFO = new Set(['HELP', 'INFO']);

export type StopIntent = 'stop' | 'start' | 'help' | null;

/**
 * Detect a regulated STOP / START / HELP keyword in the first token of
 * a user's inbound message.
 *
 * @returns `'stop'` for any opt-out keyword, `'start'` for opt-in,
 *   `'help'` for HELP / INFO, `null` for everything else.
 */
export function detectStopIntent(text: string | null | undefined): StopIntent {
  if (!text || typeof text !== 'string') return null;

  // First non-whitespace token, uppercase, punctuation stripped.
  const firstToken = text
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^a-zA-Z]/g, '')
    .toUpperCase();
  if (!firstToken) return null;

  if (OPT_OUT.has(firstToken)) return 'stop';
  if (OPT_IN.has(firstToken)) return 'start';
  if (INFO.has(firstToken)) return 'help';
  return null;
}
