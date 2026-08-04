/**
 * Tests for `scripts/dev-server.mjs` — the launcher that lets a Sunrise app
 * declare its dev port in an env file instead of a remembered `-p` flag.
 *
 * The behaviour that matters is the *precedence* between the four ways a port
 * can be specified, and the fact that two different child CLIs need it
 * delivered two different ways.
 *
 * `resolvePort` and `main` take their IO — filesystem, environment, dotenv
 * loader, spawn — as injected dependencies, so the wiring is exercised without
 * touching the disk or starting a process. That also reaches the branch a dev
 * checkout cannot reproduce: dotenv pruned by a production install.
 *
 * Not covered here: `resolveBin` and `readProjectFile` (thin wrappers over
 * `existsSync`/`readFileSync`) and the signal re-raise in the exit handler,
 * which would kill the test runner. Those were verified by running the launcher
 * against the real dev server.
 *
 * @see scripts/dev-server.mjs
 */

import { EventEmitter } from 'node:events';

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  TARGETS,
  envFilesFor,
  hasExplicitPortFlag,
  isValidPort,
  readPortFromFiles,
  buildLaunch,
  resolvePort,
  main,
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

  describe('resolvePort', () => {
    const io = (files: Record<string, string>, env: Record<string, string> = {}) => ({
      env,
      readFile: fakeReader(files),
      loadParser: async () => parseEnv,
      warn: vi.fn(),
    });

    it('takes a real environment variable over any file', async () => {
      const deps = io({ '.env.local': 'PORT=3021\n' }, { PORT: '4100' });

      await expect(resolvePort(TARGETS['next-dev'], deps)).resolves.toEqual({
        value: '4100',
        file: 'environment',
      });
    });

    it('falls to the env files when the environment is silent', async () => {
      const deps = io({ '.env.development': 'PORT=3021\n' });

      await expect(resolvePort(TARGETS['next-dev'], deps)).resolves.toEqual({
        value: '3021',
        file: '.env.development',
      });
    });

    it('reads production env files for the production target', async () => {
      const deps = io({ '.env.development': 'PORT=3021\n', '.env.production': 'PORT=8080\n' });

      await expect(resolvePort(TARGETS['next-start'], deps)).resolves.toEqual({
        value: '8080',
        file: '.env.production',
      });
    });

    it('returns null when nothing sets the variable', async () => {
      const deps = io({ '.env': 'DATABASE_URL=postgresql://localhost:5432/app\n' });

      await expect(resolvePort(TARGETS['next-dev'], deps)).resolves.toBeNull();
    });

    it('warns instead of failing when dotenv has been pruned from the install', async () => {
      // `npm ci --omit=dev` removes dotenv. The launcher must still start the
      // server — it just cannot read the files, and must say so rather than
      // silently ignore a port the operator believes they configured.
      const warn = vi.fn();
      const deps = {
        env: {},
        readFile: fakeReader({ '.env.development': 'PORT=3021\n' }),
        loadParser: async () => {
          throw new Error("Cannot find module 'dotenv'");
        },
        warn,
      };

      await expect(resolvePort(TARGETS['next-dev'], deps)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dotenv is not installed'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PORT'));
    });
  });

  describe('main', () => {
    /** Minimal stand-in for a spawned child process. */
    function fakeChild() {
      const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
      child.kill = vi.fn();
      return child;
    }

    type SpawnOptions = { env: Record<string, string | undefined> };

    function deps(overrides: Record<string, unknown> = {}) {
      return {
        spawnFn: vi.fn((_command: string, _args: string[], _options: SpawnOptions) => fakeChild()),
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
        io: { env: {}, readFile: () => null, loadParser: async () => parseEnv, warn: vi.fn() },
        ...overrides,
      };
    }

    /**
     * The fake child implements only what `main` uses — `on` and `kill` — not
     * the full ChildProcess surface, so the cast is at the boundary rather than
     * paid for by loosening the production signature.
     */
    const run = (argv: string[], d: ReturnType<typeof deps>) =>
      main(argv, d as unknown as Parameters<typeof main>[1]);

    afterEach(() => {
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    });

    it('refuses an unknown target and does not spawn anything', async () => {
      const d = deps();

      await run(['bogus'], d);

      expect(d.error).toHaveBeenCalledWith(expect.stringContaining('Unknown target "bogus"'));
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.spawnFn).not.toHaveBeenCalled();
    });

    it('names the file when a configured port is not a valid port', async () => {
      const d = deps({
        io: {
          env: {},
          readFile: (file: string) => (file === '.env.development' ? 'PORT=not-a-port\n' : null),
          loadParser: async () => parseEnv,
          warn: vi.fn(),
        },
      });

      await run(['next-dev'], d);

      expect(d.error).toHaveBeenCalledWith(
        expect.stringContaining('PORT="not-a-port" (from .env.development)')
      );
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.spawnFn).not.toHaveBeenCalled();
    });

    it('passes the resolved port to the child through the environment', async () => {
      const d = deps({ io: { env: { PORT: '3021' }, readFile: () => null, warn: vi.fn() } });

      await run(['next-dev'], d);

      const [, args, options] = d.spawnFn.mock.calls[0];
      expect(args).toEqual(['dev']);
      expect(options.env.PORT).toBe('3021');
      expect(d.log).toHaveBeenCalledWith('> PORT=3021 (from environment)');
    });

    it('leaves an explicit -p flag alone and consults no files', async () => {
      const readFile = vi.fn(() => 'PORT=3021\n');
      const d = deps({
        io: { env: {}, readFile, loadParser: async () => parseEnv, warn: vi.fn() },
      });

      await run(['next-dev', '-p', '4100'], d);

      const [, args, options] = d.spawnFn.mock.calls[0];
      expect(args).toEqual(['dev', '-p', '4100']);
      expect(options.env.PORT).toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
      expect(d.log).not.toHaveBeenCalled();
    });

    it('exits with the child’s code so a failed build fails the npm script', async () => {
      const child = fakeChild();
      const d = deps({ spawnFn: vi.fn(() => child) });

      await run(['next-dev'], d);
      child.emit('exit', 3, null);

      expect(d.exit).toHaveBeenCalledWith(3);
    });

    it('reports a child that could not be started at all', async () => {
      const child = fakeChild();
      const d = deps({ spawnFn: vi.fn(() => child) });

      await run(['next-dev'], d);
      child.emit('error', new Error('spawn ENOENT'));

      expect(d.error).toHaveBeenCalledWith(expect.stringContaining('Failed to start "next"'));
      expect(d.exit).toHaveBeenCalledWith(1);
    });

    it('forwards Ctrl-C to the child rather than orphaning it', async () => {
      const child = fakeChild();
      const d = deps({ spawnFn: vi.fn(() => child) });

      await run(['next-dev'], d);
      process.emit('SIGINT');

      expect(child.kill).toHaveBeenCalledWith('SIGINT');
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
