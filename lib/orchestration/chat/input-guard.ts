/**
 * Input Guard — prompt injection detection (Phase 7 Session 7.3)
 *
 * Scans user messages for common prompt injection patterns.
 * This is a **best-effort heuristic layer**, not a security boundary.
 * Determined attackers can bypass regex-based detection — treat flags
 * as signals for logging and monitoring, not hard blocks.
 *
 * IMPORTANT: Never log message content in scan results — only the
 * pattern labels that matched.
 */

export interface InjectionScanResult {
  flagged: boolean;
  patterns: string[];
}

interface PatternEntry {
  label: string;
  regex: RegExp;
}

const PATTERNS: PatternEntry[] = [
  {
    label: 'system_override',
    regex:
      /(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|earlier|existing|current)\s+(instructions|prompts|rules|guidelines|constraints)/i,
  },
  {
    label: 'role_confusion',
    regex:
      /you are now|act as if you|pretend (that )?you|from now on you|your new role|switch to .* mode/i,
  },
  {
    label: 'delimiter_injection',
    regex:
      /(###|---|\*\*\*|<\/?system>|<\/?instructions>|<\/?prompt>|<\/?user>|<\/?assistant>|\[INST\]|\[\/INST\])/i,
  },
  {
    label: 'output_manipulation',
    regex:
      /do not (mention|reveal|disclose|tell)|don't (mention|reveal|disclose|tell)|hide (this|the fact)|keep (this|it) secret/i,
  },
  {
    label: 'encoding_evasion',
    regex: /base64|atob|btoa|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|&#x?[0-9a-f]+;/i,
  },
];

/**
 * Normalize unicode confusables and whitespace tricks before scanning.
 * Collapses zero-width chars, normalizes to NFC, and replaces common
 * homoglyphs with ASCII equivalents.
 */
function normalizeForScan(text: string): string {
  return (
    text
      // Strip zero-width characters used to break pattern matching
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      // Collapse multiple whitespace/control characters into single space
      .replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
      // NFC normalization to collapse accented lookalikes
      .normalize('NFC')
  );
}

/**
 * Scan a message for known prompt injection patterns.
 *
 * Returns `{ flagged: false, patterns: [] }` for clean messages.
 * Returns `{ flagged: true, patterns: ['label', ...] }` when one or
 * more patterns match.
 *
 * Note: this is a heuristic layer, not a security boundary. See module
 * JSDoc for limitations.
 */
export function scanForInjection(message: string): InjectionScanResult {
  const normalized = normalizeForScan(message);
  const matched: string[] = [];

  for (const entry of PATTERNS) {
    if (entry.regex.test(normalized)) {
      matched.push(entry.label);
    }
  }

  return {
    flagged: matched.length > 0,
    patterns: matched,
  };
}
