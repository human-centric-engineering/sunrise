/**
 * Tests for `lib/orchestration/env-template.ts`.
 *
 * Covers:
 *   - containsEnvTemplate fast path / matching
 *   - extractEnvTemplateNames order and dedup
 *   - resolveEnvTemplate substitution (single, multiple, mixed)
 *   - fail-closed on missing or empty env var
 *   - malformed templates left as literal
 *   - resolveEnvTemplatesInRecord
 *   - regex `lastIndex` state isolation across calls
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EnvTemplateError,
  containsEnvTemplate,
  extractEnvTemplateNames,
  resolveEnvTemplate,
  resolveEnvTemplatesInRecord,
} from '@/lib/orchestration/env-template';

describe('env-template', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('containsEnvTemplate', () => {
    it('returns false for a plain literal', () => {
      expect(containsEnvTemplate('https://hooks.slack.com/services/T/B/X')).toBe(false);
    });

    it('returns true for a single substitution', () => {
      expect(containsEnvTemplate('${env:SLACK_WEBHOOK_URL}')).toBe(true);
    });

    it('returns true for a substitution mixed with literal text', () => {
      expect(containsEnvTemplate('Bearer ${env:FOO}')).toBe(true);
    });

    it('rejects malformed references — empty name', () => {
      expect(containsEnvTemplate('${env:}')).toBe(false);
    });

    it('rejects malformed references — lowercase', () => {
      expect(containsEnvTemplate('${env:foo}')).toBe(false);
    });

    it('rejects malformed references — leading digit', () => {
      expect(containsEnvTemplate('${env:1FOO}')).toBe(false);
    });

    it('rejects malformed references — embedded space', () => {
      expect(containsEnvTemplate('${env:HAS SPACE}')).toBe(false);
    });

    it('is idempotent across calls (no lastIndex leak)', () => {
      expect(containsEnvTemplate('${env:FOO}')).toBe(true);
      expect(containsEnvTemplate('${env:FOO}')).toBe(true);
      expect(containsEnvTemplate('${env:FOO}')).toBe(true);
    });
  });

  describe('extractEnvTemplateNames', () => {
    it('returns empty for a plain literal', () => {
      expect(extractEnvTemplateNames('plain string')).toEqual([]);
    });

    it('returns one name for a single template', () => {
      expect(extractEnvTemplateNames('${env:FOO}')).toEqual(['FOO']);
    });

    it('returns names in order of first appearance', () => {
      expect(extractEnvTemplateNames('${env:A}/${env:B}/${env:C}')).toEqual(['A', 'B', 'C']);
    });

    it('deduplicates repeated references', () => {
      expect(extractEnvTemplateNames('${env:FOO}-${env:BAR}-${env:FOO}')).toEqual(['FOO', 'BAR']);
    });

    it('ignores malformed references', () => {
      expect(extractEnvTemplateNames('${env:foo}-${env:VALID}-${env:}')).toEqual(['VALID']);
    });

    it('is repeatable (no lastIndex leak)', () => {
      const input = '${env:A}-${env:B}';
      expect(extractEnvTemplateNames(input)).toEqual(['A', 'B']);
      expect(extractEnvTemplateNames(input)).toEqual(['A', 'B']);
    });
  });

  describe('resolveEnvTemplate', () => {
    it('returns the input unchanged when no template is present', () => {
      const out = resolveEnvTemplate('https://hooks.slack.com/services/T/B/X');
      expect(out).toBe('https://hooks.slack.com/services/T/B/X');
    });

    it('substitutes a single reference', () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/X';
      expect(resolveEnvTemplate('${env:SLACK_WEBHOOK_URL}')).toBe(
        'https://hooks.slack.com/services/T/B/X'
      );
    });

    it('substitutes multiple references in one string', () => {
      process.env.SLACK_TEAM = 'T123';
      process.env.SLACK_HOOK = 'B456';
      expect(
        resolveEnvTemplate('https://hooks.slack.com/services/${env:SLACK_TEAM}/${env:SLACK_HOOK}/X')
      ).toBe('https://hooks.slack.com/services/T123/B456/X');
    });

    it('substitutes the same reference more than once', () => {
      process.env.FOO = 'bar';
      expect(resolveEnvTemplate('${env:FOO}-${env:FOO}')).toBe('bar-bar');
    });

    it('mixes literal text with substitutions', () => {
      process.env.TOKEN = 'abc123';
      expect(resolveEnvTemplate('Bearer ${env:TOKEN}')).toBe('Bearer abc123');
    });

    it('throws EnvTemplateError when an env var is unset', () => {
      delete process.env.MISSING_VAR;
      expect(() => resolveEnvTemplate('${env:MISSING_VAR}')).toThrow(EnvTemplateError);
    });

    it('throws EnvTemplateError when an env var is set to empty string', () => {
      process.env.EMPTY_VAR = '';
      expect(() => resolveEnvTemplate('${env:EMPTY_VAR}')).toThrow(EnvTemplateError);
    });

    it('error carries the offending env var name', () => {
      delete process.env.MISSING;
      try {
        resolveEnvTemplate('${env:MISSING}');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(EnvTemplateError);
        const e = err as EnvTemplateError;
        expect(e.code).toBe('unresolved_env_var');
        expect(e.envVarName).toBe('MISSING');
      }
    });

    it('throws on the FIRST missing env var even when others are set', () => {
      process.env.PRESENT = 'ok';
      delete process.env.MISSING;
      try {
        resolveEnvTemplate('${env:MISSING}-${env:PRESENT}');
        expect.fail('expected throw');
      } catch (err) {
        expect((err as EnvTemplateError).envVarName).toBe('MISSING');
      }
    });

    it('leaves malformed references in place as literal text', () => {
      const input = '${env:lower} stays put';
      expect(resolveEnvTemplate(input)).toBe(input);
    });
  });

  describe('resolveEnvTemplatesInRecord', () => {
    it('returns undefined for undefined input', () => {
      expect(resolveEnvTemplatesInRecord(undefined)).toBeUndefined();
    });

    it('returns an empty object for an empty record', () => {
      expect(resolveEnvTemplatesInRecord({})).toEqual({});
    });

    it('substitutes values, leaves keys untouched', () => {
      process.env.AUTH_TOKEN = 'sk_live_abc';
      const out = resolveEnvTemplatesInRecord({
        Authorization: 'Bearer ${env:AUTH_TOKEN}',
        'X-Static': 'literal',
      });
      expect(out).toEqual({
        Authorization: 'Bearer sk_live_abc',
        'X-Static': 'literal',
      });
    });

    it('throws EnvTemplateError when any value references a missing env var', () => {
      process.env.OK = 'good';
      delete process.env.MISSING;
      expect(() =>
        resolveEnvTemplatesInRecord({
          A: 'Bearer ${env:OK}',
          B: 'Bearer ${env:MISSING}',
        })
      ).toThrow(EnvTemplateError);
    });
  });
});
