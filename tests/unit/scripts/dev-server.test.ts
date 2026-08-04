/**
 * Tests for `scripts/dev-server.mjs` — the launcher that lets a Sunrise app
 * declare its dev port in an env file instead of a remembered `-p` flag.
 *
 * The behaviour that matters is the *precedence* between the four ways a port
 * can be specified, and the fact that two different child CLIs need it
 * delivered two different ways. Both are pure functions here; the spawn wiring
 * around them is not exercised.
 *
 * @see scripts/dev-server.mjs
 */

import { describe, it, expect } from 'vitest';

import {
  TARGETS,
  envFilesFor,
  hasExplicitPortFlag,
  isValidPort,
  readPortFromFiles,
  buildLaunch,
} from '@/scripts/dev-server.mjs';

/** Build a `readFile` stub over a virtual set of env files. */
function fakeReader(files: Record<string, string>) {
  return (file: string): string | null => files[file] ?? null;
}

/** Stand-in for dotenv's parser — enough for `KEY=value` lines. */
function parseEnv(raw: string): Record<string, string | undefined> {
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [
          key.trim(),
          rest
            .join('=')
            .trim()
            .replace(/^["']|["']$/g, ''),
        ];
      })
  );
}

describe('scripts/dev-server', () => {
  describe('envFilesFor', () => {
    it("orders dev env files by Next's own precedence, highest first", () => {
      expect(envFilesFor('development')).toEqual([
        '.env.development.local',
        '.env.local',
        '.env.development',
        '.env',
      ]);
    });

    it('scopes the mode-specific files to the given NODE_ENV', () => {
      expect(envFilesFor('production')).toEqual([
        '.env.production.local',
        '.env.local',
        '.env.production',
        '.env',
      ]);
    });
  });

  describe('hasExplicitPortFlag', () => {
    it.each([['-p'], ['--port'], ['--port=4100']])('detects %s', (flag) => {
      expect(hasExplicitPortFlag([flag, '4100'])).toBe(true);
    });

    it('ignores unrelated flags', () => {
      expect(hasExplicitPortFlag(['--turbo', '--experimental-https'])).toBe(false);
    });

    it('does not mistake a different flag that merely starts with -p', () => {
      expect(hasExplicitPortFlag(['--profile'])).toBe(false);
    });
  });

  describe('isValidPort', () => {
    it.each([['3000'], ['3021'], ['1'], ['65535']])('accepts %s', (value) => {
      expect(isValidPort(value)).toBe(true);
    });

    it.each([
      ['', 'empty'],
      ['abc', 'not a number'],
      ['30 21', 'contains a space'],
      ['3021abc', 'trailing junk'],
      ['-1', 'negative'],
      ['0', 'port zero'],
      ['65536', 'above the TCP range'],
      ['3021.5', 'not an integer'],
    ])('rejects %s (%s)', (value) => {
      expect(isValidPort(value)).toBe(false);
    });
  });

  describe('readPortFromFiles', () => {
    it('returns the value and the file it came from', () => {
      const read = fakeReader({ '.env.development': 'PORT=3021\n' });

      expect(readPortFromFiles('PORT', envFilesFor('development'), read, parseEnv)).toEqual({
        value: '3021',
        file: '.env.development',
      });
    });

    it('prefers a higher-precedence file over a lower one', () => {
      const read = fakeReader({
        '.env.local': 'PORT=3021\n',
        '.env.development': 'PORT=3099\n',
        '.env': 'PORT=3000\n',
      });

      expect(readPortFromFiles('PORT', envFilesFor('development'), read, parseEnv)).toEqual({
        value: '3021',
        file: '.env.local',
      });
    });

    it('falls through a file that exists but does not set the variable', () => {
      const read = fakeReader({
        '.env.local': 'DATABASE_URL=postgresql://localhost:5432/app\n',
        '.env.development': 'PORT=3021\n',
      });

      expect(readPortFromFiles('PORT', envFilesFor('development'), read, parseEnv)).toEqual({
        value: '3021',
        file: '.env.development',
      });
    });

    it('returns null when no file sets the variable', () => {
      const read = fakeReader({ '.env': '# nothing here\n' });

      expect(readPortFromFiles('PORT', envFilesFor('development'), read, parseEnv)).toBeNull();
    });

    it('reads the variable it is asked for, not just PORT', () => {
      const read = fakeReader({ '.env.local': 'PORT=3021\nEMAIL_PORT=3010\n' });

      expect(readPortFromFiles('EMAIL_PORT', envFilesFor('development'), read, parseEnv)).toEqual({
        value: '3010',
        file: '.env.local',
      });
    });
  });

  describe('buildLaunch', () => {
    it('hands Next its port through the environment, which its CLI reads', () => {
      const { args, env } = buildLaunch(TARGETS['next-dev'], [], '3021');

      expect(args).toEqual(['dev']);
      expect(env).toEqual({ PORT: '3021' });
    });

    it('hands react-email its port as -p, since that CLI has no env binding', () => {
      const { args, env } = buildLaunch(TARGETS['email-dev'], [], '3010');

      expect(args).toEqual(['dev', '-p', '3010']);
      expect(env).toEqual({});
    });

    it('forwards extra arguments to the child ahead of the injected port', () => {
      const { args } = buildLaunch(TARGETS['email-dev'], ['--dir', './emails'], '3010');

      expect(args).toEqual(['dev', '--dir', './emails', '-p', '3010']);
    });

    it('adds nothing when no port was resolved, leaving the CLI default in place', () => {
      const { args, env } = buildLaunch(TARGETS['next-start'], ['--turbo'], null);

      expect(args).toEqual(['start', '--turbo']);
      expect(env).toEqual({});
    });
  });

  describe('target table', () => {
    it('runs the production server against production env files', () => {
      expect(TARGETS['next-start'].nodeEnv).toBe('production');
      expect(TARGETS['next-dev'].nodeEnv).toBe('development');
    });

    it('keeps the email preview server on its own variable so it cannot collide', () => {
      expect(TARGETS['email-dev'].envVar).toBe('EMAIL_PORT');
      expect(TARGETS['next-dev'].envVar).toBe('PORT');
    });
  });
});
