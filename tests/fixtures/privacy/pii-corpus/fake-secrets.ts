/**
 * Credential-shaped strings for the corpus, assembled at load time.
 *
 * Built from pieces so that no credential-shaped literal appears in the
 * source: secret scanners (GitHub push protection, TruffleHog in CI) match
 * the file text, and a fixture that trips them blocks the push. None of these
 * is a real key, and none passes any vendor's own checksum.
 */
const pad = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

export const FAKE_SECRETS = {
  anthropic: ['sk', 'ant', 'api03', pad('Xq7v', 40)].join('-'),
  openai: ['sk', 'proj', pad('Lm3n', 32)].join('-'),
  github: ['gh', 'p_', pad('a1B2c3', 36)].join(''),
  aws: ['AK', 'IA', pad('Q7XZ', 16)].join(''),
  slack: ['xo', 'xb-', pad('1234-', 24)].join(''),
  stripe: ['sk', '_live_', pad('T9pW', 24)].join(''),
  jwt: [
    ['ey', 'J', pad('hbGciOi', 20)].join(''),
    ['ey', 'J', pad('zdWIiOi', 30)].join(''),
    pad('Sfl4wK', 26),
  ].join('.'),
  password: ['Tr0ub4', 'dor&3'].join(''),
} as const;
