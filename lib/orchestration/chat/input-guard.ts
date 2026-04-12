/**
 * Input Guard — prompt injection detection (Phase 7 Session 7.3)
 *
 * Scans user messages for common prompt injection patterns.
 * Log-only — never blocks requests. False positives on legitimate
 * queries would be worse than logging false flags.
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
      /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  },
  {
    label: 'role_confusion',
    regex: /you are now|act as if you|pretend (that )?you/i,
  },
  {
    label: 'delimiter_injection',
    regex: /(###|---|\*\*\*|<\/?system>|<\/?instructions>|<\/?prompt>)/i,
  },
];

/**
 * Scan a message for known prompt injection patterns.
 *
 * Returns `{ flagged: false, patterns: [] }` for clean messages.
 * Returns `{ flagged: true, patterns: ['label', ...] }` when one or
 * more patterns match.
 */
export function scanForInjection(message: string): InjectionScanResult {
  const matched: string[] = [];

  for (const entry of PATTERNS) {
    if (entry.regex.test(message)) {
      matched.push(entry.label);
    }
  }

  return {
    flagged: matched.length > 0,
    patterns: matched,
  };
}
